import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const header = `<task>
Read-only correction review of bounded grid memory attribution. Return an explicit PASS or FAIL for readiness to launch ONE fixed64-writer30-transition snapshot run, NOT memory acceptance. List P0/P1/P2 findings with file/line, causal impact and smallest correction; distinguish proven defects from uncertainty. No edits, no subagents, no expensive tests. This packet contains the source and verification evidence; no need for repository-wide discovery.
User requires same deterministic workload, assertions, lifecycle and default heap limits as preserved100; lightweight scalar per-transition memory/storage/owner telemetry; actual worker snapshots10/20/30 after settle+GC; offline constructor/dominator/root paths; no speculative product cleanup or serialized-byte subtraction. Full unchanged100 comes AFTER actual attribution. No actual30 snapshots exist yet.
Prior Sol review found missing staged-source custody and incorrect mixed-known/unknown epoch classification. Fable conditional readiness required releasing census summary frame, real-owner test, and baseline equivalence proof. These have been addressed; independently check code. Grok's prior tool-based run exhausted turns and had NO_VERDICT; this complete packet retry has no tools.
Actual fixture/v3 baseline copies SHA256 match original completed100 command. Their diffs below are scalar observational additions only. Shared runner epoch-body/assertions match original; per-epoch async frame returns before observation, a deliberate measurement-boundary change, not product cleanup. Fixed100 remains unprofiled. Do not mistake aggregate memory acceptance for capture readiness.
Source-error stream destruction waits close, which closes fd even autoClose:false; success fsync+close are explicit. Node22 getHeapSnapshot source emits end without close; generic pipeline caused preserved failed smoke, hence manual pipe. No heap increase is authorized for workload or needed for current analyzer controls.
32 focused tests pass, clean whole-program type check1340sources, corrected real snapshot smoke passes. Earlier launch errors, creator-only API misuse in test and wrong8DB oracle preserved. Correct actual inventory is creator primary seal-vote/evidence DB plus4relatedDBs/peer; real2writercontrol passes exact9. MessageQueueManager depth remains unavailable; not counted as gate promise. New offline ownership helper is not a product fix; selected factory must be verified through current global indexedDB binding, disjoint anchor retained sizes only are summed. Real attribution still pending.
</task>
<output_contract>Explicit readiness verdict, severity findings, corrected-finding dispositions, limitations. Review only this bounded capture seam, not unrelated dirty-tree governance.</output_contract>
`;
const files = [
 'tests/fixtures/grid-memory-profiler.ts','tests/fixtures/grid-memory-storage-census.ts',
 'tests/fixtures/grid-transition-workload.ts','tests/phase-6b-grid-30-transition-attribution.test.ts',
 'tests/phase-6b-grid-100-transition-diagnostic.test.ts','.logs/grid-memory-attribution/completed100-workload-baseline.ts',
 'tests/fixtures/grid-memory-custody.mjs','.logs/grid-memory-attribution/run.mjs',
 'tests/grid-memory-attribution-contract.test.ts','tests/grid-memory-custody.test.ts',
 'tests/grid-memory-runtime-owners.test.ts','tests/grid-memory-storage-lineage.test.ts','tests/grid-memory-snapshot-errors.test.ts',
 'tests/fixtures/grid-heap-analyze.mjs','tests/fixtures/grid-heap-compare.mjs','tests/fixtures/grid-heap-store-ownership.mjs',
 '.logs/grid-memory-attribution/correction-final-controls/stdout.log',
 '.logs/grid-memory-attribution/correction-final-types/stdout.log',
 '.logs/grid-memory-attribution/corrected-profiler-smoke-v2/status.json',
];
let packet = header;
for(const file of files){const bytes=readFileSync(file);packet += `\n<file path="${file}" sha256="${createHash('sha256').update(bytes).digest('hex')}">\n${bytes.toString()}\n</file>\n`;}
const original = JSON.parse(readFileSync('.logs/d110c-grid-authority/grid100-diagnostic-terminal-lifecycle-repaired/command.json'));
for(const [baseline,current] of [['.logs/grid-memory-attribution/completed100-fixture-baseline.ts','tests/fixtures/grid-room-workload.ts'],['.logs/grid-memory-attribution/completed100-v3-live-baseline.ts','packages/node/src/v3-live.ts']]){
 const hash=createHash('sha256').update(readFileSync(baseline)).digest('hex');
 if(hash!==original.sources[current])throw Error('BASELINE_MISMATCH');
 packet+=`\n<verified_baseline file="${current}" sha256="${hash}" matchesOriginal100="true">\n${spawnSync('diff',['-u',baseline,current],{encoding:'utf8'}).stdout}\n</verified_baseline>\n`;
}
writeFileSync('.logs/grid-memory-attribution/correction-review-packet.md',packet,{flag:'wx'});
console.log(JSON.stringify({bytes:Buffer.byteLength(packet),files:files.length}));
