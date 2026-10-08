import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

let packet = `<task>
Review two bounded test-harness corrections against actual heap evidence. Start with VERDICT: PASS or VERDICT: FAIL, then concrete P0/P1/P2 blockers and limitations; keep final response within700words. No edits, tests, subagents, broad repository discovery, or dependency changes. Read this complete source-grounded packet; prior review opinions are not evidence.
The 64-writer30 capture produced valid worker-local10/20/30 snapshots with hashes below, then FAILED final accounting. All failures remain preserved. We will rerun SAMEfixed30 to verify both corrections and heap-owner change, then unchanged64-writer100 without heavy profiling. No heap-limit or retention-policy change; no product cleanup. Original completed100 baseline remains untouched.
Confirmed growing harness owner: installedVitest3.1.1 recordAsyncExpect registers a test.onFinished callback even after await. Its fulfilled matcher promise retains Assertion.__flags.object=the original rejection TypeError; lazy CallSiteInfo retains publishAccepted closure and room context. Strong BFS excluding EVERY weak and conditionalephemeron edge finds oldrooms73/83/93 at10/20/30, currentrooms64; fixed64 original input projection callbacks plus9/19/29 oldrooms throughonFinished. onFinished counts10/20/30. This is test-lifetime error retention, not product lifecycle leak. The fixed64 initial callback residue is explicitly bounded harness baseline, not changed in this slope-focused pass. Observed arrays are bounded across snapshots.
GREEN replaces the ONE expected-publication async matcher with an async fixture helper mapping anyrejection->true/anyfulfillment->false, then synchronous expect(boolean).toBe(true), returningvoid. InstalledChai baretoThrow accepts ANYthrown payload, includingundefined/nonError; do NOT requireError or touch rejection.stack. Originallabel preserved, subsequent durable publication/signed lineage/recovery assertions unchanged. SeparateREDauthor tests confirm oldmatcher+1onFinished, missinghelperRED, helper0callbacks over repeatedarbitraryrejections, resolutionsfail, opaquegetter untouched. Assess whether promise/error references can still reach Vitest or survive the helper frame.
Second correction: prepare's exact64control check is specific to afterreopen. Finalepoch30 hasNOreopen and legitimate64fences+4causalJoins=68 controls: eachissue reduces64tipfrontier under maxDependencies16 by15; ceil((64-16)/15)=4. Existingguard wrongly ranbeforeterminalaccounting census. Guardprepare with epoch<TRANSITIONS, leave checkpoint/census unconditional. Final ordinary issue() callsalready await startup. No loosened64guard, no removed workload assertion, no changed100observer. Previousfailed30 is genuineRED for terminalcondition; GREENfull30stillpending.
DB dominated graph growth10->30=37,271,959 of47,342,018 graphbytes; remaining10,070,059 not fully numerically attributed. These are graphbytes, NOT processheap corrections. Snapshot10/20/30 sizes includeoverlap-freealternative DBdominatorpartition; do NOTsum with nestedrecords/index totals. The new30 validates ownerelimination, not arbitrary slope acceptance. No allocation samplingneeded tofindsite because errorstack+installedmatcher source directlylocateit.
</task>
`;
function include(file, text) { packet += `\n<file path="${file}">\n${text}\n</file>\n`; }
const base='.logs/grid-memory-attribution/capture30-startup-settled/runner-baseline.ts';
const hash=createHash('sha256').update(readFileSync(base)).digest('hex');
if(hash!=='ca95d950e8a28b78b7545592c218f94d6d9fed2187207850abf1107591e7a815')throw Error('BASELINE_MISMATCH');
include('exact runner delta from failed capture',spawnSync('diff',['-u',base,'tests/fixtures/grid-transition-workload.ts'],{encoding:'utf8'}).stdout);
for(const file of [
 'tests/fixtures/grid-expected-publication-failure.ts','tests/grid-memory-async-assertion-retention.test.ts',
 '.logs/grid-memory-attribution/async-assertion-red/stdout.log','.logs/grid-memory-attribution/async-assertion-green/stdout.log',
 '.logs/grid-memory-attribution/async-assertion-types/stdout.log','.logs/grid-memory-attribution/async-assertion-lint-final/status.json',
 '.logs/grid-memory-attribution/async-assertion-format/stdout.log',
 '.logs/grid-memory-attribution/capture30-startup-settled/status.json',
 '.logs/grid-memory-attribution/capture30-startup-settled/stderr.log',
])include(file,readFileSync(file,'utf8'));
const excerpts=[
 ['node_modules/.pnpm/@vitest+expect@3.1.1/node_modules/@vitest/expect/dist/index.js',891,936],
 ['node_modules/.pnpm/@vitest+expect@3.1.1/node_modules/@vitest/expect/dist/index.js',979,1007],
 ['node_modules/.pnpm/@vitest+expect@3.1.1/node_modules/@vitest/expect/dist/index.js',1520,1557],
 ['node_modules/.pnpm/chai@5.2.0/node_modules/chai/chai.js',2711,2761],
 ['tests/fixtures/grid-transition-workload.ts',300,325],['tests/fixtures/grid-transition-workload.ts',437,495],
 ['tests/fixtures/grid-room-workload.ts',328,352],
 ['packages/node/src/v3-live.ts',3614,3625],['packages/node/src/v3-live.ts',6958,7006],
 ['examples/v3-room/src/index.ts',4535,4580],
];
for(const[file,start,end]of excerpts)include(`${file}:${start}`,readFileSync(file,'utf8').split('\n').slice(start-1,end).map((line,i)=>`${start+i}: ${line}`).join('\n'));
const summary=JSON.parse(readFileSync('.logs/grid-memory-attribution/capture30-startup-settled/analysis/summary.json','utf8'));
include('heap evidence scalar summary',JSON.stringify({status:summary.status,analyzer:summary.analyzer,currentFactory:summary.currentFactory,data:summary.data.map(d=>({transition:d.transition,snapshotHash:d.snapshotHash,graphShallowBytes:d.graphShallowBytes,currentDatabaseCount:d.currentDatabaseCount,currentRawStoreCount:d.currentRawStoreCount,rawDatabaseRetainedBytes:d.rawDatabaseRetainedBytes,currentRooms:d.currentRooms,noncurrentRooms:d.noncurrentRooms,noncurrentStrongRoomPaths:d.noncurrentStrongRoomPaths,onFinished:d.onFinished,observerContainers:d.observerContainers})),limitations:summary.limitations},null,2));
const owners=JSON.parse(readFileSync('.logs/grid-memory-attribution/capture30-startup-settled/analysis/strong-owners30.json','utf8'));
include('representative independent strong room path',JSON.stringify(owners.rooms.find(r=>!r.current&&r.strongPath.path.some(p=>p.id===233205)),null,2));
include('independent strong path algorithm',readFileSync('.logs/grid-memory-attribution/capture30-startup-settled/analysis/strong-owners.mjs','utf8'));
writeFileSync('.logs/grid-memory-attribution/assertion-review-packet.md',packet,{flag:'wx'});
console.log(JSON.stringify({bytes:Buffer.byteLength(packet),baselineSha256:hash}));
