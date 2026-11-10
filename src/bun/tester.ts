import { BrowserView, BrowserWindow, Utils } from 'electrobun/main';
import { dirname,basename } from 'node:path';
import { TesterRuntime,testerProfile } from './tester-runtime';
import { DEFAULTS,loadSettings,saveSettings } from './settings';
import { pluginAsset } from './plugin-assets';
import { FileIcons } from './file-icon';
import { createNativePopover,positionPopover } from './native-popover';
import { setTrayHighlighted } from './tray-highlight';
import pkg from '../../package.json';
const root=testerProfile(process.env.TOOLBELT_TESTER_PROFILE);
process.env.TOOLBELT_CONFIG_DIR=root;
const runtime=new TesterRuntime(root,pkg.version);
let settings=loadSettings({...DEFAULTS,shortcut:''});
const icons=new FileIcons(root+'/cache/icons');
let unwatch:(()=>void)|undefined;
const views=new Set<any>();
const reports=new Map<number,(value:unknown)=>void>();let reportId=0;
let native:ReturnType<typeof createNativePopover>|undefined;
const broadcast=(name:string,payload:unknown)=>views.forEach(view=>view.send[name](payload));
async function evalIn(js:string,target='window'){const view=target==='popover'?native?.popover.webview:win.webview;if(!view)return{error:'No native popover'};const id=++reportId;return new Promise(resolve=>{reports.set(id,resolve);view.executeJavascript(`Promise.resolve().then(()=>(${js})).then(v=>window.__tbReport(${id},v),e=>window.__tbReport(${id},{error:String(e)}))`);setTimeout(()=>{if(reports.has(id)){reports.delete(id);resolve({error:'timeout'})}},10000)})}
export async function testerControl(operation:string,p:Record<string,any>={}){
 switch(operation){
  case'load':await runtime.load(p.archive,p.repo,p.approved===true);return true;
  case'watch':if(p.approved!==true)throw new Error('Explicit execution approval required');unwatch?.();unwatch=runtime.watchArchive(dirname(p.archive),basename(p.archive),p.repo);return true;
  case'unwatch':unwatch?.();unwatch=undefined;return true;
  case'diagnostics':return runtime.diagnostics;
  case'reset':await runtime.reset(p.id);return true;
  case'nativePopover':{
   if(!native){native=createNativePopover({title:'Toolbelt Plugin Tester',url:'views://ui/index.html#popover',image:'views://assets/tray-icon-dev@2x.png',template:false,rpc:makeRPC()});native.tray.on('tray-clicked',()=>{if(native!.popover.isVisible())hideNative();else showNative()});native.popover.on('blur',hideNative)}showNative();return true;
  }
  default:throw new Error('Unknown tester operation');
 }
}
function showNative(){if(!native)return;const {x,y}=positionPopover(native.tray);native.popover.setFrame(x,y,380,520);native.popover.show();native.popover.activate();setTrayHighlighted(true);broadcast('popoverShown',{})}
function hideNative(){if(!native?.popover.isVisible())return;setTrayHighlighted(false);broadcast('popoverHiding',{});setTimeout(()=>native?.popover.hide(),160)}
function makeRPC(){const rpc:any=BrowserView.defineRPC({maxRequestTime:120000,handlers:{requests:{
 tester:({operation,...params}:any)=>testerControl(operation,params),
 plugins:()=>runtime.host.list(),open:(p:any)=>runtime.host.open(p.plugin,p.surface),close:(p:any)=>{runtime.host.close(p.plugin,p.surface);return true},
 event:(p:any)=>{runtime.record('event',p);runtime.host.event(p.plugin,p.surface,p.name,p.payload);return true},restartPlugin:(p:any)=>{runtime.host.restart(p.plugin);return true},
 settings:()=>({...settings,shortcutLabel:'None (tester)',shortcutError:null}),setAppearance:(p:any)=>{settings={...settings,...p};saveSettings(settings);broadcast('settingsChanged',{});return true},setShortcut:()=>({ok:false,error:'Global shortcuts disabled in tester'}),pauseShortcut:()=>true,
 fileIcon:(p:any)=>icons.get(p.path),pluginAsset:(p:any)=>pluginAsset(runtime.packages,p.reference),pluginManager:async(p:any)=>{if(p.operation==='enable')await runtime.packages.enabled(p.id,p.enabled);if(p.operation==='remove')await runtime.packages.remove(p.id,p.deleteData);return{installed:Object.values(runtime.packages.registry().plugins).filter(p=>!p.removed)}},
 openUrl:(p:any)=>/^(https?:|mailto:)/i.test(p.url)&&Utils.openExternal(p.url),updateState:()=>({enabled:false,version:pkg.version,checking:false,lastChecked:null,nextCheck:null,lastError:null,latest:null,phase:{kind:'idle'},available:null,channel:'tester',appPath:null}),checkForUpdates:()=>true,installUpdate:()=>true,cancelUpdate:()=>true,dismissUpdate:()=>true,
 },messages:{showWindow:(p:any)=>{hideNative();win.show();win.activate();broadcast('navigate',p)},hidePopover:hideNative,popoverSize:(p:any)=>{if(native&&p.height){const f=native.popover.getFrame();native.popover.setFrame(f.x,f.y,380,Math.max(120,Math.min(520,p.height)))}},closeWindow:()=>win.close(),zoomWindow:()=>{if(win.isMaximized())win.unmaximize();else win.maximize()},debugReport:({id,value}:any)=>{reports.get(id)?.(value);reports.delete(id)},quit:()=>win.close()}}} as any);views.add(rpc);return rpc}
runtime.host.subscribe({plugins:list=>broadcast('plugins',list),tree:(plugin,surface,tree)=>broadcast('tree',{plugin,surface,tree}),toast:(plugin,text,tone,action)=>broadcast('toast',{plugin,text,tone,action})});
await runtime.start();
const win=new BrowserWindow({title:'Toolbelt Plugin Tester',url:'views://ui/index.html',frame:{x:120,y:120,width:1280,height:900},rpc:makeRPC()});
win.on('close',()=>{unwatch?.();void runtime.stop().finally(()=>process.exit(0))});
if(process.env.TOOLBELT_DEBUG_PORT)Bun.serve({hostname:'127.0.0.1',port:Number(process.env.TOOLBELT_DEBUG_PORT),async fetch(req){const url=new URL(req.url);try{if(url.pathname==='/state')return Response.json({pid:process.pid,root,plugins:runtime.host.list(),diagnostics:runtime.diagnostics});if(url.pathname==='/eval'&&req.method==='POST')return Response.json(await evalIn(await req.text(),url.searchParams.get('target')??'window'));if(url.pathname==='/control'&&req.method==='POST'){const{operation,...params}=await req.json();return Response.json(await testerControl(operation,params))}return new Response('Not found',{status:404})}catch(error){return Response.json({error:String(error)},{status:400})}}});
