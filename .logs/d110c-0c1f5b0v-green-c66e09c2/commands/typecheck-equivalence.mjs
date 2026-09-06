import {readFileSync} from 'node:fs';
const [baseline,current]=process.argv.slice(2);
const rows=p=>readFileSync(p,'utf8').split('\n').filter(l=>l.startsWith('packages/node typecheck:')&&/error TS\d+/.test(l)).map(l=>l.replaceAll(/(?:\/Users\/aristotle\/Documents\/Projects\/ts-drp-1|\/private\/tmp\/d110c-f5b0v-green-LLxy4p\/checkout|\/tmp\/d110c-f5b0v-green-LLxy4p\/checkout)/g,'<repo>')).sort();
const before=rows(baseline),after=rows(current),equal=JSON.stringify(before)===JSON.stringify(after);
console.log(JSON.stringify({baseline,current,baselineCount:before.length,currentCount:after.length,equal,diagnostics:after},null,2));
if(!equal||before.length!==13)process.exitCode=1;
