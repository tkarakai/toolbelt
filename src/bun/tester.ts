import { BrowserView, BrowserWindow, Utils } from "electrobun/main";
import { dirname, basename } from "node:path";
import { TesterRuntime, testerProfile } from "./tester-runtime";
import { DEFAULTS, loadSettings, saveSettings } from "./settings";
import { pluginAsset } from "./plugin-assets";
import { FileIcons } from "./file-icon";
import pkg from "../../package.json";

// Set before settings/cache/plugins are constructed. Never inherit official app overrides.
const root = testerProfile(process.env.TOOLBELT_TESTER_PROFILE);
process.env.TOOLBELT_CONFIG_DIR = root;
const runtime = new TesterRuntime(root, pkg.version);
let settings = loadSettings({...DEFAULTS, shortcut:""});
const icons = new FileIcons(root + "/cache/icons");
let unwatch: (() => void) | undefined;
export async function testerControl(operation: string, p: Record<string, any> = {}) {
  switch(operation) {
    case "load": await runtime.load(p.archive, p.repo, p.approved === true); return true;
    case "watch":
      if(p.approved !== true) throw new Error("Explicit execution approval required");
      unwatch?.(); unwatch = runtime.watchArchive(dirname(p.archive), basename(p.archive), p.repo); return true;
    case "unwatch": unwatch?.(); unwatch = undefined; return true;
    case "diagnostics": return runtime.diagnostics;
    case "reset": await runtime.reset(p.id); return true;
    case "nativePopover": throw new Error("Native tray factory integration pending; see docs/plugin-tester.md");
    default: throw new Error("Unknown tester operation");
  }
}
const requests: Record<string, (p:any)=>any> = {
  tester: ({operation,...params}) => testerControl(operation, params),
  plugins: () => runtime.host.list(),
  open: p => runtime.host.open(p.plugin,p.surface),
  close: p => { runtime.host.close(p.plugin,p.surface); return true; },
  event: p => { runtime.record("event",p); runtime.host.event(p.plugin,p.surface,p.name,p.payload); return true; },
  restartPlugin: p => {runtime.host.restart(p.plugin);return true;},
  settings: () => ({...settings,shortcutLabel:"None (tester)",shortcutError:null}),
  setAppearance: p => { settings={...settings,...p}; saveSettings(settings); rpc.send.settingsChanged({}); return true; },
  setShortcut: () => ({ok:false,error:"Global shortcuts are disabled in the tester"}),
  pauseShortcut: () => true,
  fileIcon: p => icons.get(p.path),
  pluginAsset: p => pluginAsset(runtime.packages,p.reference),
  pluginManager: () => ({installed:Object.values(runtime.packages.registry().plugins).filter(p=>!p.removed)}),
  openUrl: p => /^(https?:|mailto:)/i.test(p.url) && Utils.openExternal(p.url),
  updateState: () => ({phase:"idle",available:null,channel:"dev"}),
  checkForUpdates: () => true, installUpdate: () => true, cancelUpdate: () => true, dismissUpdate: () => true,
};
const rpc:any = BrowserView.defineRPC({maxRequestTime:120000,handlers:{requests, messages:{
  showWindow: (p:any) => rpc.send.navigate(p), hidePopover:()=>{}, popoverSize:()=>{},
  closeWindow:()=>win.close(), zoomWindow:()=>{}, debugReport:()=>{}, quit:()=>win.close(),
}}} as any);
runtime.host.subscribe({plugins:list=>rpc.send.plugins(list),tree:(plugin,surface,tree)=>rpc.send.tree({plugin,surface,tree}),toast:(plugin,text,tone,action)=>rpc.send.toast({plugin,text,tone,action})});
await runtime.start();
const win = new BrowserWindow({title:"Toolbelt Plugin Tester",url:"views://ui/index.html",frame:{x:120,y:120,width:1280,height:900},rpc});
win.on("close",()=>{unwatch?.();void runtime.stop().finally(()=>process.exit(0));});
