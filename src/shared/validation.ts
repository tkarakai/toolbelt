import { LIMITS } from './package';
import type { Node, PluginMessage } from './protocol';
const object=(v:unknown):v is Record<string,any> => !!v && typeof v==='object' && !Array.isArray(v);
const need=(ok:unknown,message:string)=>{if(!ok) throw new Error(message)};
const str=(v:unknown)=>typeof v==='string';
const array=(v:unknown)=>Array.isArray(v);
/** Runtime validation before any value reaches React. Unknown properties remain forward-compatible. */
export function validateTree(value:unknown): asserts value is Node {
 let count=0;
 const walk=(v:any,depth:number)=>{
  need(depth<=LIMITS.depth && ++count<=LIMITS.nodes,'tree complexity limit');
  need(object(v)&&str(v.type),'node object/type required');
  const strings=(...keys:string[])=>keys.forEach(k=>need(str(v[k]),`${v.type}.${k} must be text`));
  const items=(key:string,fn:(x:any)=>void)=>{need(array(v[key]),`${v.type}.${key} must be array`);v[key].forEach(fn)};
  const actions=(a:any)=>{need(array(a),'actions array required');a.forEach((x:any)=>need(object(x)&&str(x.id)&&str(x.label),'invalid action'))};
  if(v.actions!==undefined)actions(v.actions);
  switch(v.type){
   case 'stack':case 'page':case 'card': items('children',x=>walk(x,depth+1));break;
   case 'table':strings('id');items('columns',x=>need(object(x)&&str(x.key)&&str(x.title),'invalid column'));items('rows',function row(x:any){need(object(x)&&str(x.id)&&object(x.cells),'invalid row');if(x.children!==undefined){need(array(x.children),'invalid child rows');x.children.forEach(row)}});break;
   case 'list':strings('id');items('items',x=>need(object(x)&&str(x.id)&&str(x.title),'invalid list item'));break;
   case 'stats':case 'details':items('items',x=>need(object(x)&&str(x.label)&&str(x.value),'invalid detail/stat'));break;
   case 'form':strings('id');items('fields',x=>{need(object(x)&&str(x.id)&&str(x.label),'invalid field');need(['environment','select','switch','text'].includes(x.type),'invalid field type');if(x.type==='switch')need(typeof x.value==='boolean','invalid switch');else if(x.type==='environment')need(array(x.value),'invalid environment');else need(str(x.value),'invalid text/select');if(x.type==='select')need(array(x.options),'invalid select options')});break;
   case 'empty':strings('title');break;
   case 'text':case 'markdown':strings('text');break;
   case 'log':case 'terminal':strings('id');items('lines',x=>need(v.type==='terminal'?str(x):object(x)&&str(x.text),'invalid log line'));break;
   case 'conversation':strings('id');items('messages',x=>need(object(x)&&['user','assistant','tool','system'].includes(x.role)&&str(x.text),'invalid conversation message'));break;
   case 'segmented':strings('id','value');items('options',x=>need(object(x)&&str(x.value)&&str(x.label),'invalid option'));break;
   case 'progress':if(v.value!==undefined)need(typeof v.value==='number'&&Number.isFinite(v.value)&&v.value>=0&&v.value<=1,'invalid progress');break;
   default:throw new Error(`unknown node ${v.type}`);
  }
  if(v.dialog!==undefined){need(object(v.dialog)&&str(v.dialog.id)&&str(v.dialog.title)&&array(v.dialog.children),'invalid dialog');v.dialog.children.forEach((x:any)=>walk(x,depth+1));if(v.dialog.actions)actions(v.dialog.actions)}
 };
 // Bound every nested object, including rows/cells, before more specialized recursive parsing.
 const bound=(v:unknown,d:number)=>{need(d<=LIMITS.depth&&++count<=LIMITS.nodes,'tree complexity limit');if(v&&typeof v==='object')for(const x of Object.values(v))bound(x,d+1);else need(v===null||['string','boolean','number'].includes(typeof v),'invalid JSON tree value')};
 bound(value,0);count=0;walk(value,0);
}
export function validateMessage(value:unknown): asserts value is PluginMessage {
 need(object(value)&&str(value.type),'invalid protocol message'); const v=value as any;
 switch(v.type){
 case 'hello':need(Number.isSafeInteger(v.protocol)&&str(v.sdk)&&array(v.capabilities)&&v.capabilities.every(str),'invalid hello');break;
 case 'ready':break;
 case 'prepared':need(str(v.requestId)&&typeof v.ready==='boolean'&&(v.reason===undefined||str(v.reason)),'invalid prepared');break;
 case 'render':need(str(v.surface),'invalid surface');validateTree(v.tree);break;
 case 'badge':need(v.value===null||str(v.value)||typeof v.value==='number','invalid badge');break;
 case 'toast':need(str(v.text)&&(!v.tone||['default','success','error'].includes(v.tone)),'invalid toast');if(v.action)need(object(v.action)&&str(v.action.id)&&str(v.action.label),'invalid toast action');break;
 case 'clipboard':need(str(v.text),'invalid clipboard');break;
 default:throw new Error('unknown protocol message');
 }
}
