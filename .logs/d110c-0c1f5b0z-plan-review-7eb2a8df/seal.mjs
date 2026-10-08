import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const out=path.dirname(new URL(import.meta.url).pathname);
const read=name=>fs.readFileSync(path.join(out,name),'utf8');
const parse=text=>JSON.parse(text.slice(text.lastIndexOf('{"terminal":')));
const events=read('fable/events.jsonl').trim().split('\n').map(JSON.parse);
const terminal=events.filter(event=>event.type==='result');
if(terminal.length!==1||terminal[0].is_error||terminal[0].stop_reason!=='end_turn'||terminal[0].permission_denials.length||terminal[0].subagent_stats.spawned)throw Error('Fable terminal');
const models=[...new Set(events.map(event=>event.message?.model).filter(Boolean))];
if(models.length!==1||models[0]!=='claude-fable-5-1')throw Error('Fable model');
const grokStatus=JSON.parse(read('grok/status.json'));
if(grokStatus.classification!=='TERMINAL_RESPONSE')throw Error('Grok terminal');
const reviews={grok:parse(read('grok/public.txt')),sol:JSON.parse(read('sol-read-resume/final.txt')),fable:parse(terminal[0].result)};
for(const [name,review]of Object.entries(reviews)){
  for(const severity of ['P0','P1','P2'])if(review[severity.toLowerCase()+'_count']!==review.findings.filter(finding=>finding.severity===severity).length)throw Error(name+' count');
}
const initialSol=JSON.parse(read('sol/final.txt'));
if(initialSol.verdict!=='NO_VERDICT')throw Error('initial Sol disposition');
const summary={reviews,initialSol,blockingFindings:Object.entries(reviews).flatMap(([reviewer,review])=>review.findings.filter(finding=>['P0','P1'].includes(finding.severity)).map(finding=>({reviewer,...finding}))),fableIdentity:{models,session:terminal[0].session_id,stop_reason:terminal[0].stop_reason},reviewCheckoutUnchanged:execFileSync('git',['-C','/private/tmp/d110c-f5b0z-review-Kg6cuq/checkout','status','--porcelain=v1'],{encoding:'utf8'}).trim()===''};
if(!summary.reviewCheckoutUnchanged)throw Error('review checkout changed');
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const files=directory=>fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(directory,entry.name)):[path.join(directory,entry.name)]);
const entries=files(out).filter(file=>path.relative(out,file)!=='manifest.sha256').sort().map(file=>hash(fs.readFileSync(file))+'  '+path.relative(out,file));
fs.writeFileSync(path.join(out,'manifest.sha256'),entries.join('\n')+'\n',{flag:'wx'});
console.log(JSON.stringify({blocking:summary.blockingFindings,entries:entries.length,manifest:hash(read('manifest.sha256'))},null,2));
