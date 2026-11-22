import { encodeCanonical } from "/Users/aristotle/Documents/Projects/ts-drp-1/packages/canonical/src/index.ts";
const hex=(i:number,s:string)=>(s.repeat(64)+i.toString(16)).slice(-64);
const members:any[]=[];for(let i=0;i<64;i++)members.push({author:hex(i,"b"),finalityKey:hex(i,"c"),groups:["admin","finality","referee","writer"]});
members.sort((a,b)=>a.author<b.author?-1:1);
const snap={epoch:1,kind:"drp-v3-latched-acl",members,objectId:"o".repeat(64),permissionless:false,version:2};
console.log("64 full members bytes:",encodeCanonical(snap).byteLength);
const m2=members.map(m=>({author:m.author,finalityKey:null,groups:["writer"]}));
console.log("64 writer-only members bytes:",encodeCanonical({...snap,members:m2}).byteLength);
