import { definePlugin, type PluginDefinition } from './index';
import type { HostMessage, PluginMessage } from '../shared/protocol';
/** In-memory transport using the production SDK; call close() to release the reader. */
export function fakeHost(def:PluginDefinition){
 const messages:PluginMessage[]=[];let wake:(()=>void)|undefined;let ended=false;const queue:HostMessage[]=[];
 const input:AsyncIterable<Uint8Array>={async *[Symbol.asyncIterator](){while(!ended){if(!queue.length)await new Promise<void>(r=>wake=r);wake=undefined;while(queue.length)yield new TextEncoder().encode(JSON.stringify(queue.shift())+'\n')}}};
 const context=definePlugin(def,{input,write:line=>messages.push(JSON.parse(line))});
 return {messages,context,send(message:HostMessage){queue.push(message);wake?.()},close(){ended=true;wake?.()}};
}
