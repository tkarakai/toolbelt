import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TesterRuntime,testerProfile} from '../src/bun/tester-runtime';
test('profiles cannot escape the tester root',()=>{expect(testerProfile('fixture','/scratch')).toBe('/scratch/profiles/fixture');for(const name of ['../Toolbelt','','a/b'])expect(()=>testerProfile(name,'/scratch')).toThrow()});
test('diagnostics bounded and malformed archives use production rejection',async()=>{const root=mkdtempSync(join(tmpdir(),'tester-'));const runtime=new TesterRuntime(root,'0.1.0');try{const archive=join(root,'broken.tar.gz');writeFileSync(archive,'broken');await expect(runtime.load(archive,'fixture/repo',true)).rejects.toThrow();expect(runtime.diagnostics.at(-1)?.kind).toBe('error');for(let n=0;n<300;n++)runtime.record('test','x'.repeat(20000));expect(runtime.diagnostics.length).toBe(200);expect(JSON.stringify(runtime.diagnostics[0]).length).toBeLessThan(17000);expect(()=>runtime.watchArchive(root,'../bad.tar.gz','fixture/repo')).toThrow();await expect(runtime.reset('missing')).rejects.toThrow('Unknown');}finally{await runtime.stop();rmSync(root,{recursive:true,force:true})}});
