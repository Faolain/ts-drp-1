import {spawnSync} from 'node:child_process';
const ports=[4174,4175,51000,51002];
const listeners=ports.map(port=>{const r=spawnSync('lsof',['-nP',`-iTCP:${port}`,'-sTCP:LISTEN'],{encoding:'utf8'});if(r.status!==0&&r.status!==1)throw Error(`lsof ${port} failed`);return {port,status:r.status,stdout:r.stdout,stderr:r.stderr}});
const ps=spawnSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'});
if(ps.status!==0)throw Error('process snapshot failed');
const relevant=ps.stdout.split('\n').filter(line=>/vitest|playwright.+test|retained-heap-child|snapshot-stream-memory-child/.test(line));
console.log(JSON.stringify({time:new Date().toISOString(),listeners,relevantProcesses:relevant},null,2));
