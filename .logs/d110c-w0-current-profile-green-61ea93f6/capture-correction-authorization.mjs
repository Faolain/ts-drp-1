import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),source='.logs/d110c-current-contract-design-draft-61ea93f6/w0-control-observer-correction.md',bytes=fs.readFileSync(path.join(root,source));
const sha256=crypto.createHash('sha256').update(bytes).digest('hex');fs.writeFileSync(path.join(out,'control-observer-correction/authorization.md'),bytes,{flag:'wx'});fs.writeFileSync(path.join(out,'control-observer-correction/authorization.json'),JSON.stringify({source,sha256,byteIdentical:true,unrelatedRegistryAndGridDraftsNotIncluded:true},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({source,sha256,byteIdentical:true}));
