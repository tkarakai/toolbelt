import { popoverPosition, popoverLayout } from "../shared/popover";
import { BrowserWindow, Tray, Screen } from 'electrobun/main';
/** Shared native shell; production and tester render the same Popover inside it. */
export function createNativePopover(options:{title:string;url:string;image:string;template:boolean;rpc:any}){
 const tray=new Tray({title:'',image:options.image,template:options.template,width:18,height:18});
 const popover=new BrowserWindow({title:options.title,url:options.url,frame:{width:380,height:520,x:0,y:0},titleBarStyle:'hidden',styleMask:{Resizable:false,Miniaturizable:false,Closable:false},transparent:true,hidden:true,activate:false,rpc:options.rpc});
 popover.setAlwaysOnTop(true);popover.setVisibleOnAllWorkspaces(true);return{tray,popover};
}
export function positionPopover(tray:Tray,width=380){return popoverPosition(tray.getBounds(),Screen.getPrimaryDisplay(),width)}

/** Resize the combined list/details window without changing the list's tray anchor. */
export function layoutNativePopover(tray: Tray, popover: BrowserWindow, height: number, details: boolean, anchorTop = 0, reserveHeight = 0) {
 const layout = popoverLayout(tray.getBounds(), Screen.getPrimaryDisplay(), height, details, anchorTop, reserveHeight);
 popover.setFrame(layout.x, layout.y, layout.width, layout.height);
 return layout;
}
