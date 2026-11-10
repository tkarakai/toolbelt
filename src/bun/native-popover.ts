import { BrowserWindow, Tray, Screen } from 'electrobun/main';
/** Shared native shell; production and tester render the same Popover inside it. */
export function createNativePopover(options:{title:string;url:string;image:string;template:boolean;rpc:any}){
 const tray=new Tray({title:'',image:options.image,template:options.template,width:18,height:18});
 const popover=new BrowserWindow({title:options.title,url:options.url,frame:{width:380,height:520,x:0,y:0},titleBarStyle:'hidden',styleMask:{Resizable:false,Miniaturizable:false,Closable:false},transparent:true,hidden:true,activate:false,rpc:options.rpc});
 popover.setAlwaysOnTop(true);popover.setVisibleOnAllWorkspaces(true);return{tray,popover};
}
export function positionPopover(tray:Tray,width=380){const b=tray.getBounds(),display=Screen.getPrimaryDisplay();return{x:Math.round(Math.min(Math.max(b.x-2,display.workArea.x+4),display.workArea.x+display.workArea.width-width-4)),y:Math.round((b.height?display.bounds.height-b.y:display.workArea.y)-1)}}
