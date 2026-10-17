// Browser adapter for the existing accepted warm worker's routing boundary.
// No trust/admission facts are sent over this channel. The parent binds each
// fixed peer ID to its frame source and original storage origin.
const handlers=new Set<(packet:unknown)=>void>();
window.addEventListener("message",event=>{
 if(event.source!==window.parent||event.data?.kind!=="r8-grid-worker-delivery")return;
 for(const handler of handlers)handler(event.data.packet);
});
export const parentPort={
 postMessage:(packet:unknown)=>window.parent.postMessage({kind:"r8-grid-worker-route",packet},"*"),
 on:(event:string,handler:(packet:unknown)=>void)=>{if(event!=="message")throw new Error("healthy browser port supports messages only");handlers.add(handler);},
 close:()=>{handlers.clear();}
};
Reflect.set(globalThis,"setImmediate",(callback:()=>void)=>setTimeout(callback,0));
