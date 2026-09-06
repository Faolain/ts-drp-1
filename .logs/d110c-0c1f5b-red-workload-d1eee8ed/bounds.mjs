import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const canonicalSourcePath = path.resolve('packages/canonical/src/index.ts');
const { encodeCanonical, hashDomain } = await import(pathToFileURL(canonicalSourcePath).href);
const out = path.dirname(new URL(import.meta.url).pathname);
const fixture = 'tests/fixtures/phase-6b-d110c-0c1f5b/transient-payload-application.ts';
const test = 'tests/phase-6b-d110c-0c1f5b-integration-red.test.ts';
const source = fs.readFileSync(fixture, 'utf8');
const tree = ts.createSourceFile(fixture, source, ts.ScriptTarget.Latest, true);
const declarations = new Map(tree.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations.map(declaration => [declaration.name.getText(tree), declaration.initializer])));
const id = declarations.get('ARTIFACT_ID');
const template = declarations.get('ARTIFACT_SOURCE');
assert(ts.isStringLiteral(id));
assert(ts.isTemplateExpression(template));
let artifactSource = template.head.text;
for (const span of template.templateSpans) {
  assert.equal(span.expression.getText(tree), 'ARTIFACT_ID');
  artifactSource += id.text + span.literal.text;
}
const { blueprint } = await import('data:text/javascript;base64,' + Buffer.from(artifactSource).toString('base64'));
assert.equal(blueprint.artifactId, 'f5b-transient-payload.v1');
const operations = [0, 1].map(index => ({ action: 'message', clientOperationId: `displaced-${index}`, text: 'r'.repeat(33_000) }));
const entries = operations.map((operation, index) => ({ logicalTime: 7 + 2 * index, operation }));
const batch = { action: 'applicationBatch', batch: { entries, version: 1 } };
const operationBytes = operations.map(operation => encodeCanonical(operation).byteLength);
assert(operationBytes.every(length => length < 65_536));
const batchBytes = encodeCanonical(batch).byteLength;
assert(batchBytes > 65_536);
const foldedBatch = blueprint.reducers.applicationBatch({ operation: batch, state: [] });
let singleState = [];
for (const operation of operations) singleState = blueprint.reducers.message({ operation, state: singleState }).state;
assert.deepEqual(singleState, foldedBatch.state);
assert.deepEqual(singleState, [0, 1].map(index => ({ clientOperationId: `displaced-${index}`, text: `displaced-${index}` })));
const case3Ids = ['creator-before-close', 'writer-before-close', 'displaced-0', 'displaced-1', 'creator-during-writer-crash', 'after-cold-reopen', 'creator-cold-reopen', 'writer-third-reopen'];
let finalCase3State = [];
for (const clientOperationId of case3Ids) finalCase3State = blueprint.reducers.message({ state: finalCase3State, operation: { action: 'message', clientOperationId, text: 'r'.repeat(33_000) } }).state;
const case3FinalBytes = encodeCanonical(finalCase3State).byteLength;
assert(case3FinalBytes < 32_768);
const wide = [];
for (let epoch = 0; epoch < 4; epoch += 1) for (let author = 0; author < 64; author += 1) {
  const id = `wide-${epoch}-${author}`;
  wide.push({ clientOperationId: id, text: id });
}
for (let epoch = 0; epoch < 3; epoch += 1) for (let index = 0; index < 2; index += 1) wide.push({ clientOperationId: `wide-displaced-${epoch}-${index}`, text: 'r'.repeat(256) });
const wideBytes = encodeCanonical(wide).byteLength;
assert.equal(wide.length, 262);
assert.equal(wideBytes, 14_303);
assert(wideBytes <= 32_768);

const tests = fs.readFileSync(test, 'utf8');
const base = execFileSync('git', ['show', `a6a3f738:${test}`], { encoding: 'utf8' });
const case3Start = tests.indexOf('it("retains checkpoint-terminal open progress');
const case3End = tests.indexOf('// Independently attributable continuations', case3Start);
assert(case3Start > 0 && case3End > case3Start);
const outsideCase3 = tests.slice(0, case3Start) + tests.slice(case3End);
assert(!outsideCase3.includes('33_000'));
assert.equal((tests.match(/openRoom\(2, false, false, true\)/gu) ?? []).length, 1);
assert(tests.includes('F5B_C14_THREE_TRANSITIONS_AND_COLD_REOPEN'));
assert(tests.includes('F5B_64_ACTUAL_FINAL_CANONICAL_STATE_WITHIN_UNCHANGED_CEILING'));
const controlMarker = '\tit("keeps the genuine v1 room issue, close, adoption and cold reopen control unchanged"';
assert.equal(tests.slice(tests.indexOf(controlMarker)), base.slice(base.indexOf(controlMarker)));
assert.equal(tests.slice(tests.indexOf('const parameters ='), tests.indexOf('const hex =')), base.slice(base.indexOf('const parameters ='), base.indexOf('const hex =')));
assert.equal(tests.match(/60_000/gu)?.length, base.match(/60_000/gu)?.length);
assert.equal(execFileSync('git', ['diff', 'a6a3f738', '--', 'tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts'], { encoding: 'utf8' }), '');
assert(source.includes('blueprintDigests: Object.freeze([blueprintDigest])'));
assert(source.includes('implementation: { artifactId: ARTIFACT_ID, artifactDigest'));
assert(source.includes('canonicalStateBytes: migration.canonicalStateBytes'));
const result = {
  kind: 'PURE_LOCAL_ARTIFACT_AND_SOURCE_BOUND_PREFLIGHT_NOT_FOCUSED_RUNTIME',
  canonicalSourcePath,
  artifactId: id.text, artifactDigest: Buffer.from(hashDomain('ts-drp/blueprint-artifact/v3', Buffer.from(artifactSource))).toString('hex'),
  exactSingleOperationCanonicalBytes: operationBytes, exactTwoIntentBatchCanonicalBytes: batchBytes,
  exactTwoIntentReducerStateBytes: encodeCanonical(singleState).byteLength, modeledFinalCase3StateBytes: case3FinalBytes,
  wideOrdinaryOperations: 256, wideTransformedMessages: 6, modeledWideStateBytes: wideBytes,
  perOperationLimitUnchanged: 65_536, batchLimitUnchanged: 65_536, stateLimitUnchanged: 32_768,
  sourceAssertions: { case3OnlyLargeTransform: true, v1ControlByteIdentical: true, priorRuntimeTestsByteIdentical: true, parametersByteIdentical: true, timeoutUnchanged: true, threeTransitionPredicateRetained: true },
  limitation: 'Local reducer smoke/bound calculation only. Real package/invite admission is tested by the single focused room run; post-codec GREEN continuation is not claimed.',
};
fs.writeFileSync(path.join(out, 'bounds.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
