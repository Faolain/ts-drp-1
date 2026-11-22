import fs from 'node:fs';
import path from 'node:path';
const out=path.dirname(new URL(import.meta.url).pathname),runs=['focused','control-observer-correction/focused'],observations=[];
for(const run of runs){const text=fs.readFileSync(path.join(out,run,'stdout.log'),'utf8');for(const match of text.matchAll(/W0_CURRENT_PROFILE_OBSERVATION (\{[^\n]+\})/gu)){const measured=JSON.parse(match[1]);observations.push({run,measured});}}
fs.writeFileSync(path.join(out,'observations.json'),JSON.stringify({observations,limitations:'First run includes legacy final observation only. Its settlement fence durability was obtained in separate read-only post-failure inspection; no settlement close occurred in that failed run.'},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(observations.map(({run,measured:{offenderSequences,...measured}})=>({run,measured,offenderSequenceCount:offenderSequences.length,firstOffenderSequence:offenderSequences[0],lastOffenderSequence:offenderSequences.at(-1)}))));
