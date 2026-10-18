import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

let packet = `<task>
Review a bounded instrumentation correction before retrying ONE fixed64-writer30-transition memory capture. Start your answer with VERDICT: PASS or VERDICT: FAIL; give P0/P1/P2 findings, concrete source evidence, minimal corrections, and limitations. No edits, subagents, tests or broad repository discovery. Review this packet's code, not just prior opinions. This is capture readiness, NOT product memory acceptance or leak attribution.
The completed unprofiled100 is preserved. Original capture code passed initial Sol/Fable/Grok reviews but the first actual30 stopped after transition1, no snapshots. Same workload no-op and GC-only two-transition prefixes pass. Census-only reliably fails: background follower recovery is still publishing after createV3RoomSession returned. Long all-store readonly census transactions can delay admission writes while the unchanged256readonly-round transport oracle runs. Failure logs show two replacement publications expire with creator active, only51/64fences processed; no direct stored-row mutation found. The admission bound was NOT raised, no assertions weakened, no heap limits or retention policy changed.
New minimal correction: private WeakMap keyed by actual returned session -> waiter of ORIGINAL rebasePromise. Named diagnostic export rejects foreign/closed/failed sessions, preserves original error, and returnsvoid. It does not open/issue/retry/drain/close or change regular room startup readiness. The existing frozen return object is assigned a local, registered, then returned. The only persistent new references are weak-key entries; assess whether they can contaminate retention.
Fixture joins current sessions in a temporary async frame, verifies exactly one creator/current plane per session, all current writer fences admitted at creator, and active/nonterminal runtimes with no pending ingress. Shared runner optional prepareCheckpoint runs before database names and scalar owner counts are collected. Fixed30 supplies preparation; fixed100 has no observer and does not invoke it. This intentionally settles diagnostic sampling after already-started recovery at the same after-reopen ordinal. Scheduling/sample values can differ from unprofiled100; do not treat profile timing/memory as acceptance or claim byte-identical DAG interleaving.
Existing profiler still releases census frame before settledGC and actualworker snapshots10/20/30, exclusive files, no caller object retention; previous custody fixes, scalar shape controls, offline analysis remain unchanged. No broad queue API or protocol change added. This is observation correction, not a confirmed product leak cleanup.
Evidence: missinghelper RED;2 focused natural-session tests GREEN (foreign/copied/inherited/closed, repeated waits no new publications/commits, real failed startup same Error identity as issue); startup-only prefix PASS; settled-census PASS; stronger settled-census prefix immediately verifies64 admitted controls and64 unique-author signed fences after wait, PASS. Integrated optional-hook prefix is separately recorded. Typecheck clean. A combined multi-file fixture run hit existing nonconfigurable global d9336V3Chat redefinition on secondroomfixture; all33 collected controls passed and runtime-owner single-fresh-worker retest passes. Preserve this environment failure; do not alter product global registration to hide it.
Your job: assess natural ownership, failure propagation, startup/queue boundary correctness, frozen100 behavior and instrumentation retention. A startup waiter alone is not a generic message-queue idle API; the workload-specific admitted-fence and no-pending-runtime checks are important. Identify any remaining reason the capture is invalid. No product leak claim exists and no snapshots captured yet.
</task>
`;
function include(file, text){packet+=`\n<file path="${file}">\n${text}\n</file>\n`;}
const files=[
 'tests/phase-6b-grid-30-transition-attribution.test.ts','tests/phase-6b-grid-100-transition-diagnostic.test.ts',
 'tests/grid-memory-startup-barrier.test.ts','tests/grid-memory-boundary-prefix.test.ts',
 'tests/fixtures/grid-memory-profiler.ts','tests/fixtures/grid-memory-storage-census.ts',
 '.logs/grid-memory-attribution/boundary-prefix-census-only/stderr.log',
 '.logs/grid-memory-attribution/boundary-prefix-startup-only/stdout.log',
 '.logs/grid-memory-attribution/boundary-prefix-settled-census-proof/stdout.log',
 '.logs/grid-memory-attribution/startup-barrier-green/stdout.log',
 '.logs/grid-memory-attribution/startup-runtime-owners-fresh/stdout.log',
 '.logs/grid-memory-attribution/startup-integrated-types/stdout.log',
 '.logs/grid-memory-attribution/boundary-prefix-integrated/stdout.log',
 '.logs/grid-memory-attribution/boundary-prefix-integrated/status.json',
 '.logs/grid-memory-attribution/startup-final-types/stdout.log',
 '.logs/grid-memory-attribution/startup-final-static/status.json',
 '.logs/grid-memory-attribution/startup-final-format/stdout.log',
];
for(const file of files)include(file,readFileSync(file,'utf8'));
const room='examples/v3-room/src/index.ts';
const baseline='.logs/grid-memory-attribution/completed100-room-baseline.ts';
const hash=createHash('sha256').update(readFileSync(baseline)).digest('hex');
if(hash!=='251440fa07d48b97991888c5c2ddd301dc4703713c1ff3b47593a559be8cc74c')throw Error('BASELINE_MISMATCH');
include('room-source-diff-from-original100',spawnSync('diff',['-u',baseline,room],{encoding:'utf8'}).stdout);
const excerpts=[
 [room,2625,2660],[room,3658,3696],[room,4508,4578],
 ['tests/fixtures/grid-room-workload.ts',315,365],['tests/fixtures/grid-room-workload.ts',770,835],
 ['tests/fixtures/grid-transition-workload.ts',130,146],['tests/fixtures/grid-transition-workload.ts',454,506],
 ['packages/node/src/v3-live.ts',2774,2810],['packages/node/src/v3-live.ts',4280,4320],
 ['packages/node/src/v3-live.ts',9135,9172],
];
for(const [file,start,end] of excerpts)include(`${file}:${start}`,readFileSync(file,'utf8').split('\n').slice(start-1,end).map((line,index)=>`${start+index}: ${line}`).join('\n'));
writeFileSync('.logs/grid-memory-attribution/startup-review-packet.md',packet,{flag:'wx'});
console.log(JSON.stringify({bytes:Buffer.byteLength(packet),roomBaselineSha256:hash}));
