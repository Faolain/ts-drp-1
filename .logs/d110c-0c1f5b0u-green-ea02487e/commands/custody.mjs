import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const cwd=realpathSync(process.argv[2]);
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(...a)=>execFileSync('git',['-C',cwd,...a],{encoding:'utf8'});
const protectedRoots=['.agents','.claude','packages/protocol-v2/tests/author-sequence-0g2.test.ts','packages/protocol-v2/tests/local-author-sequence-issuance-0g2.test.ts','CPU.20260901.090022.81530.0.001.cpuprofile','skills-lock.json'];
function census(p){if(!existsSync(`${cwd}/${p}`))return null;const s=lstatSync(`${cwd}/${p}`);if(s.isSymbolicLink())return {symlink:true};if(s.isDirectory())return Object.fromEntries(readdirSync(`${cwd}/${p}`).sort().map(n=>[n,census(`${p}/${n}`)]));return {bytes:s.size,sha256:hash(readFileSync(`${cwd}/${p}`))};}
const stash=git('stash','list','--format=%H');
const names=['@ts-drp/node/v3-live','@ts-drp/issuance-store','@ts-drp/protocol-v3'];
const resolved=JSON.parse(execFileSync(process.execPath,['--input-type=module','--eval',`console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(name=>[name,import.meta.resolve(name)]))))`],{cwd:`${cwd}/packages/node`,encoding:'utf8'}));
const imports=Object.fromEntries(names.map(name=>{const path=realpathSync(fileURLToPath(resolved[name]));return[name,{path,sha256:hash(readFileSync(path))}];}));
console.log(JSON.stringify({head:git('rev-parse','HEAD').trim(),tree:git('rev-parse','HEAD^{tree}').trim(),signature:git('log','--format=%G?','-1').trim(),branch:git('branch','--show-current').trim(),runtime:{node:process.version,execPath:realpathSync(process.execPath),pnpm:execFileSync('pnpm',['--version'],{encoding:'utf8',cwd}).trim(),imports},lockfile:hash(readFileSync(`${cwd}/pnpm-lock.yaml`)),stashes:{count:stash.trim().split('\n').filter(Boolean).length,hash:hash(stash)},protected:Object.fromEntries(protectedRoots.map(p=>[p,census(p)])),otherProtectedExistence:Object.fromEntries(['.pnpm-store','_apalache-out'].map(p=>[p,existsSync(`${cwd}/${p}`)])),trackedStatus:git('status','--porcelain=v1','--untracked-files=no')},null,2));
