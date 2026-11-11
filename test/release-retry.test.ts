import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRetry, GitHub, resolveRetrySource } from "../src/release/github";
import type { ReleaseConfig, Request } from "../src/release/core";

const source = "a".repeat(40), later = "b".repeat(40), tag = "v1.0.1";
const adapter = {changelog:"CHANGELOG.md",version:()=>"1.0.1",setVersion:async()=>{},build:async()=>[]};
const config: ReleaseConfig = { repo:"example/plugin",hostVersion:"0.1.0",products:{plugin:adapter,sdk:adapter,app:adapter} };
const request: Request = {format:1,repo:config.repo,product:"plugin",version:"1.0.1",channel:"stable"};
function fixture() {
  const pull = {number:24,merged_at:"today",merge_commit_sha:source,base:{ref:"main",repo:{full_name:config.repo}},head:{repo:{full_name:config.repo}}};
  const state = {pull,request:{...request},authorized:true,tagSource:undefined as string|undefined,tagType:"tag",candidate:false,expired:false,remote:false,workflowBranch:"main",workflowSource:source,workflowEvent:"push",workflowPath:".github/workflows/release.yml"};
  const reads: string[] = [], dispatches: any[] = [], forbiddenWrites: string[] = [];
  const server = Bun.serve({port:0,async fetch(req) {
    const url = new URL(req.url), p = url.pathname.replace("/repos/example/plugin/", "");
    const json=(v:unknown)=>Response.json(v), missing=()=>new Response("",{status:404});
    if(req.method!=="GET") {
      if(p==="actions/workflows/release.yml/dispatches"&&req.method==="POST") {dispatches.push(await req.json());return new Response(null,{status:204});}
      forbiddenWrites.push(p);return new Response("Unexpected mutation",{status:500});
    }
    reads.push(p);
    if(p==="pulls/24")return json(state.pull);
    if(p===`commits/${source}`)return json({sha:source,files:state.authorized?[{filename:".toolbelt-release.json",status:"modified"}]:[]});
    if(p===`commits/${source}/pulls`)return json([state.pull]);
    if(p==="contents/.toolbelt-release.json"&&url.searchParams.get("ref")===source)return json({encoding:"base64",content:Buffer.from(JSON.stringify(state.request)).toString("base64")});
    if(p.startsWith("git/ref/tags/"))return state.tagSource?json({object:{type:state.tagType,sha:"annotation"}}):missing();
    if(p==="git/tags/annotation")return json({object:{type:"commit",sha:state.tagSource}});
    if(p==="actions/artifacts")return json({artifacts:state.candidate?[{id:10,expired:state.expired,workflow_run:{id:20}}]:[]});
    if(p==="actions/runs/20")return json({path:state.workflowPath,head_branch:state.workflowBranch,event:state.workflowEvent,head_sha:state.workflowSource});
    if(p.startsWith("releases/tags/"))return state.remote?json({id:1,draft:true}):missing();
    if(p==="releases")return json([]);
    // In particular, commits/main must never be consulted to identify an untagged retry.
    return missing();
  }});
  return {state,reads,dispatches,forbiddenWrites,server,gh:new GitHub(config.repo,"fake",server.url.toString().replace(/\/$/,""))};
}

test("untagged retries by merged PR or exact SHA dispatch the original source after main advances", async()=>{
  for(const selector of [{pr:"24"},{source}]) {
    const f=fixture();try {
      const plan=await dispatchRetry(f.gh,config,{tag,product:"plugin",...selector});
      expect(plan.source).toBe(source);expect(plan.candidate).toBeUndefined();
      expect(f.dispatches).toEqual([{ref:"main",inputs:{tag,source}}]);
      expect(f.reads).not.toContain("commits/main");expect(f.forbiddenWrites).toEqual([]);
    } finally {f.server.stop(true);}
  }
});
test("tag-only retries preserve an existing frozen candidate and do not mutate release bytes",async()=>{
  const f=fixture();try {
    f.state.tagSource=source;f.state.candidate=true;
    const plan=await dispatchRetry(f.gh,config,{tag,product:"plugin"});
    expect(plan.source).toBe(source);expect(plan.candidate.id).toBe(10);
    expect(f.dispatches[0].inputs.source).toBe(source);expect(f.forbiddenWrites).toEqual([]);
  }finally{f.server.stop(true);}
});
test("missing or ambiguous retry selectors fail closed before dispatch",async()=>{
  for(const selector of [{},{pr:"24",source},{source:"main"},{source:"a".repeat(39)},{pr:"0"},{pr:"-1"},{pr:"1.5"},{pr:"9007199254740992"},{pr:"https://example.test/24"}]) {
    const f=fixture();try {
      await expect(dispatchRetry(f.gh,config,{tag,...selector})).rejects.toThrow();
      expect(f.dispatches).toEqual([]);expect(f.forbiddenWrites).toEqual([]);
    }finally{f.server.stop(true);}
  }
});
test("unmerged, foreign and non-main PRs cannot authorize retries",async()=>{
  for(const change of ["unmerged","head-repo","base-repo","base-branch","merge-sha"]) {
    const f=fixture();try {
      if(change==="unmerged")f.state.pull.merged_at="";
      if(change==="head-repo")f.state.pull.head.repo.full_name="other/plugin";
      if(change==="base-repo")f.state.pull.base.repo.full_name="other/plugin";
      if(change==="base-branch")f.state.pull.base.ref="dev";
      if(change==="merge-sha")f.state.pull.merge_commit_sha="main";
      await expect(dispatchRetry(f.gh,config,{tag,pr:"24"})).rejects.toThrow();
      expect(f.dispatches).toEqual([]);
    }finally{f.server.stop(true);}
  }
});
test("ordinary source commits and mismatched product/version/channel authorizations cannot retry",async()=>{
  for(const change of ["ordinary","version","product","channel","foreign"]) {
    const f=fixture();try {
      if(change==="ordinary")f.state.authorized=false;
      if(change==="version")f.state.request.version="1.0.2";
      if(change==="product")f.state.request.product="sdk";
      if(change==="channel")f.state.request.channel="prerelease";
      if(change==="foreign")f.state.request.repo="other/plugin";
      await expect(dispatchRetry(f.gh,config,{tag,source,product:"plugin"})).rejects.toThrow();
      expect(f.dispatches).toEqual([]);
    }finally{f.server.stop(true);}
  }
});
test("immutable tag conflicts and lightweight tags cannot redirect recovery",async()=>{
  for(const kind of ["conflict","lightweight"]) {
    const f=fixture();try {
      f.state.tagSource=kind==="conflict"?later:source;if(kind==="lightweight")f.state.tagType="commit";
      await expect(dispatchRetry(f.gh,config,{tag,source})).rejects.toThrow();expect(f.dispatches).toEqual([]);
    }finally{f.server.stop(true);}
  }
});
test("expired or missing frozen bytes never trigger rebuilding a tagged or uploaded candidate",async()=>{
  for(const kind of ["expired","tag-without-draft","draft-without-tag"]) {
    const f=fixture();try {
      if(kind==="expired"){f.state.candidate=true;f.state.expired=true;}
      if(kind==="tag-without-draft")f.state.tagSource=source;
      if(kind==="draft-without-tag")f.state.remote=true;
      await expect(dispatchRetry(f.gh,config,{tag,source})).rejects.toThrow(/Frozen CI/);
      expect(f.dispatches).toEqual([]);expect(f.forbiddenWrites).toEqual([]);
    }finally{f.server.stop(true);}
  }
});
test("dispatch-created frozen artifacts remain reusable after main advances",async()=>{
  const f=fixture();try {
    f.state.candidate=true;f.state.workflowEvent="workflow_dispatch";f.state.workflowSource=later;
    const plan=await dispatchRetry(f.gh,config,{tag,source});expect(plan.candidate.id).toBe(10);
    // Frozen record source/bytes are still verified after download by the existing publisher.
  }finally{f.server.stop(true);}
});
test("candidate lookup ignores unrelated branch or push-source artifacts",async()=>{
  for(const kind of ["branch","source","workflow"]) {
    const f=fixture();try {
      f.state.candidate=true;f.state.expired=true;
      if(kind==="branch")f.state.workflowBranch="dev";
      if(kind==="source")f.state.workflowSource=later;
      if(kind==="workflow")f.state.workflowPath=".github/workflows/other.yml";
      const plan=await dispatchRetry(f.gh,config,{tag,source});expect(plan.candidate).toBeUndefined();
    }finally{f.server.stop(true);}
  }
});

async function cliFixture(f:ReturnType<typeof fixture>,args:string[],event?:unknown) {
  const root=mkdtempSync(join(tmpdir(),"tb-retry-cli-"));
  try {
    const git=Bun.spawnSync(["git","init"],{cwd:root});expect(git.exitCode).toBe(0);
    expect(Bun.spawnSync(["git","remote","add","origin","https://github.com/example/plugin.git"],{cwd:root}).exitCode).toBe(0);
    writeFileSync(join(root,"release.config.ts"),`export default {repo:'example/plugin',hostVersion:'0.1.0',products:{plugin:{changelog:'CHANGELOG.md',version:()=> '1.0.1',setVersion:async()=>{},build:async()=>[]}}};`);
    writeFileSync(join(root,"event.json"),JSON.stringify(event??{}));writeFileSync(join(root,"output"),"");
    writeFileSync(join(root,"fake-api.ts"),`const realFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(String(input));if(url.origin!=='https://api.github.com')throw Error('Unexpected network request');return realFetch(process.env.TEST_RETRY_API+url.pathname+url.search,init);};`);
    const child=Bun.spawn([process.execPath,"--preload",join(root,"fake-api.ts"),join(import.meta.dir,"../src/release/cli.ts"),...args],{cwd:root,env:{...process.env,GH_TOKEN:"fake",TEST_RETRY_API:f.server.url.origin,GITHUB_ACTIONS:"true",GITHUB_REPOSITORY:config.repo,GITHUB_REF:"refs/heads/main",GITHUB_SHA:later,GITHUB_EVENT_PATH:join(root,"event.json"),GITHUB_OUTPUT:join(root,"output")},stdin:"ignore",stdout:"pipe",stderr:"pipe"});
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    return {stdout,stderr,code,output:readFileSync(join(root,"output"),"utf8")};
  }finally{rmSync(root,{recursive:true,force:true});}
}
test("CLI retry passes the resolved original source into workflow dispatch",async()=>{
  const f=fixture();try {
    const result=await cliFixture(f,["plugin:retry","--tag",tag,"--pr","24"]);
    expect(result.code).toBe(0);expect(result.stdout).toContain("CI retry requested");expect(f.dispatches).toEqual([{ref:"main",inputs:{tag,source}}]);
  }finally{f.server.stop(true);}
});
test("CI planner honors and revalidates the original source instead of the dispatch HEAD",async()=>{
  const f=fixture();try {
    f.state.candidate=true;
    const result=await cliFixture(f,["ci-plan"],{inputs:{tag,source}});
    expect(result.code).toBe(0);expect(result.output).toContain(`source=${source}\n`);expect(result.output).toContain("reuse=true\n");expect(f.dispatches).toEqual([]);
    const conflict=await cliFixture(f,["ci-plan"],{inputs:{tag,source:later}});
    expect(conflict.code).not.toBe(0);expect(conflict.output).not.toContain("release=true");
  }finally{f.server.stop(true);}
});
test("CI retry refuses a missing selector, missing candidate or changed authorization",async()=>{
  for(const kind of ["missing-selector","missing-bytes","changed-auth"]) {
    const f=fixture();try {
      if(kind==="missing-bytes")f.state.remote=true;
      if(kind==="changed-auth")f.state.authorized=false;
      const result=await cliFixture(f,["ci-plan"],{inputs:kind==="missing-selector"?{tag}:{tag,source}});
      expect(result.code).not.toBe(0);expect(result.output).not.toContain("release=true");expect(f.forbiddenWrites).toEqual([]);
    }finally{f.server.stop(true);}
  }
});
test("SDK retries must match the explicitly requested product",async()=>{
  const f=fixture();try {
    f.state.request.product="sdk";
    await expect(resolveRetrySource(f.gh,config,{tag:"sdk-v1.0.1",product:"plugin",source})).rejects.toThrow("authorization");
    expect((await resolveRetrySource(f.gh,config,{tag:"sdk-v1.0.1",product:"sdk",source})).request.product).toBe("sdk");
  }finally{f.server.stop(true);}
});

test("tag-only CI recovery resolves an immutable source after dispatch HEAD changes",async()=>{
  const f=fixture();try {
    f.state.tagSource=source;f.state.candidate=true;
    const result=await cliFixture(f,["ci-plan"],{inputs:{tag}});
    expect(result.code).toBe(0);expect(result.output).toContain(`source=${source}\n`);expect(result.output).toContain("reuse=true\n");
    expect(f.forbiddenWrites).toEqual([]);
  }finally{f.server.stop(true);}
});
test("a source without an expected tag cannot turn a normal CI plan into a retry",async()=>{
  const f=fixture();try {
    const result=await cliFixture(f,["ci-plan"],{inputs:{source}});
    expect(result.code).not.toBe(0);expect(result.output).not.toContain("release=true");expect(f.dispatches).toEqual([]);
  }finally{f.server.stop(true);}
});
test("retry-only selectors are not accepted by release preparation",async()=>{
  const f=fixture();try {
    const result=await cliFixture(f,["plugin","--version","1.0.2","--channel","stable","--source",source]);
    expect(result.code).not.toBe(0);expect(f.reads).toEqual([]);expect(f.dispatches).toEqual([]);
  }finally{f.server.stop(true);}
});

test("candidate discovery searches beyond the first page before declaring frozen bytes expired",async()=>{
  const f=fixture();try {
    const original=f.gh.request.bind(f.gh);const pages:string[]=[];
    f.gh.request=async(path,method="GET",body?)=>{
      if(path.startsWith("actions/artifacts?")) {
        const page=new URL("https://fixture.test/"+path).searchParams.get("page");pages.push(page!);
        return {artifacts:page==="1"?Array.from({length:100},(_,i)=>({id:i+100,expired:true,workflow_run:{id:20}})):[{id:10,expired:false,workflow_run:{id:20}}]};
      }
      return original(path,method,body);
    };
    const plan=await dispatchRetry(f.gh,config,{tag,source});expect(plan.candidate.id).toBe(10);expect(pages).toEqual(["1","2"]);
  }finally{f.server.stop(true);}
});
test("missing candidate inventory is not mistaken for permission to rebuild",async()=>{
  const f=fixture();try {
    const original=f.gh.request.bind(f.gh);
    f.gh.request=(path,method="GET",body?)=>path.startsWith("actions/artifacts?")?Promise.resolve(null):original(path,method,body);
    await expect(dispatchRetry(f.gh,config,{tag,source})).rejects.toThrow("inventory");expect(f.dispatches).toEqual([]);
  }finally{f.server.stop(true);}
});
