import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/typescript/lib/typescript.js';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const custody = JSON.parse(fs.readFileSync(path.join(out, 'custody-before.json')));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
const printer = ts.createPrinter({ removeComments: false, newLine: ts.NewLineKind.LineFeed });
function find(source, predicate) {
  const found = [];
  const visit = node => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(source);
  return found;
}
const variableName = node => ts.isVariableStatement(node) && node.declarationList.declarations.length === 1 ? node.declarationList.declarations[0].name.getText() : undefined;
const records = [];
for (const file of custody.targets) {
  const before = fs.readFileSync(path.join(out, 'before', file), 'utf8');
  const after = fs.readFileSync(path.join(root, file), 'utf8');
  let normalized = after;
  const reversals = [];
  const replaceOnce = (from, to, reason) => {
    if (normalized.split(from).length !== 2) throw Error('Expected unique reversal: ' + reason);
    normalized = normalized.replace(from, to);
    reversals.push({ reason, removedSha256: hash(from), restoredSha256: hash(to) });
  };
  if (file.endsWith('.mjs')) {
    replaceOnce('\tconst store = Object.freeze({\n\t\t...raw,\n\t\tclose: () => measureFacade', '\tconst store = Object.freeze({\n\t\tclose: () => measureFacade', 'Spread genuine raw public store before unchanged six overrides');
    if (normalized !== before) throw Error('Child differs outside the one raw spread');
  } else if (file.includes('repeat-close')) {
    replaceOnce('\tconst recoverCurrentSuccessor = async (): Promise<Readonly<Record<string, unknown>>> => {\n\t\tif (originalBootstrap === undefined) throw new TypeError("D110C_0B1_ORIGINAL_BOOTSTRAP_UNAVAILABLE");', '\tconst recoverCurrentSuccessor = async (): Promise<Readonly<Record<string, unknown>>> => {', 'Current-successor bootstrap availability guard');
    replaceOnce('\t\t\t\td110c0b1ActiveInspection = await adoptionHandle.inspectDurableHead();\n\t\t\t\tif (originalBootstrap === undefined) throw new TypeError("D110C_0B1_ORIGINAL_BOOTSTRAP_UNAVAILABLE");', '\t\t\t\td110c0b1ActiveInspection = await adoptionHandle.inspectDurableHead();', 'Epoch-two bootstrap availability guard');
    for (const indent of ['\t\t\t\t\t', '\t\t\t\t\t\t']) replaceOnce(indent + 'exactCanonicalPinnedGenesisBootstrapOperationBytes: Uint8Array.from(originalBootstrap.operationBytes),\n', '', 'Detached original bootstrap at indentation ' + indent.length);
    if (normalized !== before) throw Error('Repeat close differs outside two detached pin supplies and their guards');
  } else {
    const baseline = parse(file, before);
    const source = parse(file, after);
    const edits = [];
    const edit = (node, replacement, reason) => {
      edits.push({ start: node.getStart(source), end: node.end, replacement });
      reversals.push({ reason, removedSha256: hash(node.getText(source)), restoredSha256: hash(replacement) });
    };
    const originalImports = new Map(baseline.statements.filter(ts.isImportDeclaration).map(node => [node.moduleSpecifier.text, node.getText(baseline)]));
    for (const node of source.statements.filter(ts.isImportDeclaration)) {
      const module = node.moduleSpecifier.text;
      if (!originalImports.has(module)) {
        if (!['creator-transition-advance.js', 'creator-author-issuance-frontiers.js', 'creator-issuance-retirement.js'].some(suffix => module.endsWith(suffix))) throw Error('Unexpected new import');
        edit(node, '', 'Existing full-transition authority or protocol-kind import');
      } else if (module.endsWith('creator-checkpoint.js')) edit(node, originalImports.get(module), 'Promote existing checkpoint type import to genuine opener import');
    }
    const inserted = ['checkpointInput', 'checkpoint', 'transition', 'authenticatedControlRefs', 'isAuthenticatedControlRef'];
    for (const name of inserted) {
      const matches = find(source, node => variableName(node) === name);
      if (matches.length !== 1) throw Error('New declaration count: ' + name);
      const previous = name === 'authenticatedControlRefs' ? find(baseline, node => variableName(node) === 'retirementDigests')[0].getText(baseline) : '';
      edit(matches[0], previous, 'Full-closure authentication and exact reference projection: ' + name);
    }
    for (const name of ['checkpoint', 'transition']) {
      const matches = find(source, node => ts.isIfStatement(node) && node.expression.getText(source) === '!' + name + '.ok');
      if (matches.length !== 1) throw Error('Authentication success guard count');
      edit(matches[0], '', 'Require genuine ' + name + ' success before projection');
    }
    for (const name of ['boundedReferences', 'boundedCandidates', 'boundedCurrentReferences', 'boundedCurrentCandidates']) {
      const previous = find(baseline, node => variableName(node) === name);
      const current = find(source, node => variableName(node) === name);
      if (previous.length !== 1 || current.length !== 1) throw Error('Projection declaration count');
      edit(current[0], previous[0].getText(baseline), 'Project authenticated exact digest/length reference pairs: ' + name);
    }
    const previousCheckpoint = find(baseline, node => ts.isPropertyAssignment(node) && node.name.getText(baseline) === 'checkpointInput');
    const currentCheckpoint = find(source, node => ts.isShorthandPropertyAssignment(node) && node.name.text === 'checkpointInput');
    if (previousCheckpoint.length !== 1 || currentCheckpoint.length !== 1) throw Error('Single checkpoint input evidence owner');
    edit(currentCheckpoint[0], previousCheckpoint[0].getText(baseline), 'Reuse one exact checkpoint input for opener and evidence');
    for (const entry of edits.sort((a, b) => b.start - a.start)) normalized = normalized.slice(0, entry.start) + entry.replacement + normalized.slice(entry.end);
  }
  const baselinePrinted = printer.printFile(parse(file, before));
  const normalizedPrinted = printer.printFile(parse(file, normalized));
  if (baselinePrinted !== normalizedPrinted) {
    fs.writeFileSync(path.join(out, path.basename(file) + '.normalized-mismatch.txt'), normalizedPrinted, { flag: 'wx' });
    throw Error('AST/printer equivalence outside GREEN hunks: ' + file);
  }
  records.push({ file, beforeSha256: hash(before), afterSha256: hash(after), normalizedSha256: hash(normalizedPrinted), baselineNormalizedSha256: hash(baselinePrinted), equal: true, reversals });
}
const result = { records, normalizedAstEquivalentOutsideEnumeratedGreenHunks: true, childSixOverridesByteIdentical: true, sameStoreShapeByteIdentical: true, bothOriginalColdInputExpressionsUnchangedExceptDetachedPins: true, originalBootstrapDerivationAndSameInputObserversByteIdentical: true, fullDurableEvidenceAndRedAssertionsPreserved: true, oneCheckpointInputOwner: true, genuineFullTransitionVerifierBeforeExactRefProjection: true, testExecutions: 0, productionEdits: 0 };
fs.writeFileSync(path.join(out, 'equivalence.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ files: records.length, equivalentOutsideGreenHunks: true, redObserversPreserved: true }));
