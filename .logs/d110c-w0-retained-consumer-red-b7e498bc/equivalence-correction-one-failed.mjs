import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/typescript/lib/typescript.js';
const root = '/Users/aristotle/Documents/Projects/ts-drp-1';
const out = path.dirname(new URL(import.meta.url).pathname);
const custody = JSON.parse(fs.readFileSync(path.join(out, 'custody-before.json')));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
const records = [];
const newCases = [
  'authenticates the full aggregate-bearing closure before trust-only projection',
  'opens both aggregates against independent authenticated checkpoint and closure bindings',
];
for (const file of custody.targets) {
  const beforeText = fs.readFileSync(path.join(out, 'before', file), 'utf8');
  const afterText = fs.readFileSync(path.join(root, file), 'utf8');
  const before = parse(file, beforeText);
  const after = parse(file, afterText);
  const basename = path.basename(file);
  const removed = [];
  const sourceText = node => node.getText(after);
  const transformations = ts.transform(after, [context => {
    const remove = (node, reason) => { removed.push({ kind: ts.SyntaxKind[node.kind], reason, sha256: hash(sourceText(node)) }); return undefined; };
    const visitor = node => {
      if (ts.isFunctionDeclaration(node) && node.name && [
        'observePublicStore', 'originalBootstrapOperation', 'aggregateCandidate', 'checkpointAnchorAclDigest', 'fullTransition',
      ].includes(node.name.text)) return remove(node, 'new observational/test helper ' + node.name.text);
      if (ts.isImportDeclaration(node)) {
        if (basename === 'phase-6b-d110c-0b1-boundaries.test.ts' && [
          '../packages/node/src/internal/creator-transition-advance.js',
          '../packages/protocol-v3/src/creator-author-issuance-frontiers.js',
        ].includes(node.moduleSpecifier.text)) return remove(node, 'new assertion-only real authority import');
        if (node.moduleSpecifier.text === '@ts-drp/canonical' && ['repeat-close-contract.ts', 'phase-6b-d110c-0b1-boundaries.test.ts'].includes(basename)) {
          const removeNames = basename === 'repeat-close-contract.ts' ? ['compareBytes', 'hashDomain'] : ['hashDomain'];
          const bindings = node.importClause.namedBindings;
          removed.push({ kind: 'ImportSpecifier', reason: 'new observation/assertion imports', names: removeNames });
          return ts.factory.updateImportDeclaration(node, node.modifiers, ts.factory.updateImportClause(node.importClause, node.importClause.isTypeOnly, node.importClause.name, ts.factory.updateNamedImports(bindings, bindings.elements.filter(element => !removeNames.includes(element.name.text)))), node.moduleSpecifier, node.attributes);
        }
      }
      if ((ts.isPropertySignature(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name && ['publicStoreContract', 'coldBootstrap'].includes(node.name.getText(after))) return remove(node, 'new detached observation field');
      if (ts.isVariableStatement(node)) {
        const names = node.declarationList.declarations.map(declaration => declaration.name.getText(after));
        if (names.length === 1 && ['publicStoreContract', 'publicKeys', 'publicSurface', 'originalBootstrap', 'coldBootstrapInputs', 'observeColdInput', 'bootstrap'].includes(names[0])) return remove(node, 'new observation/assertion variable ' + names[0]);
      }
      if (ts.isExpressionStatement(node)) {
        const expression = node.expression;
        if (ts.isCallExpression(expression) && expression.expression.getText(after) === 'it' && ts.isStringLiteral(expression.arguments[0]) && newCases.includes(expression.arguments[0].text)) return remove(node, 'new bounded authority test case');
        const text = sourceText(node);
        if (text.startsWith('originalBootstrap = await originalBootstrapOperation(hot)')) return remove(node, 'one original bootstrap observation derivation');
        if (text.startsWith('expect.soft(proof?.publicStoreContract)')) return remove(node, 'public surface assertion');
        if (basename === 'phase-6b-d110c-0b1-bounded-checkpoint-red.test.ts' && (text.startsWith('expect(') || text.startsWith('expect.soft(')) && (text.includes('bootstrap.original') || text.includes('bootstrap.inputs') || text.includes('drp-creator-author-issuance-frontiers-state'))) return remove(node, 'new bootstrap or aggregate observation assertion');
      }
      if (ts.isCallExpression(node) && node.expression.getText(after) === 'observeColdInput') {
        if (node.arguments.length !== 2 || !ts.isStringLiteral(node.arguments[1]) || !['current-successor', 'epoch-two'].includes(node.arguments[1].text)) throw Error('Unrecognized cold observer');
        removed.push({ kind: 'CallExpression', reason: 'same-input cold observation wrapper', site: node.arguments[1].text });
        return ts.visitNode(node.arguments[0], visitor);
      }
      if (basename === 'repeat-close-contract.ts' && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken && node.right.getText(after) === 'originalBootstrap === undefined') {
        removed.push({ kind: 'BinaryExpression', reason: 'observer availability guard' });
        return ts.visitNode(node.left, visitor);
      }
      if (basename === 'phase-6b-d110c-0b1-bounded-checkpoint-red.test.ts' && ts.isCallExpression(node)) {
        const restore = { 'expect(currentCensus).toHaveLength': [7, 6], 'expect(proposedCensus).toHaveLength': [6, 5], 'expect(activeCensus).toHaveLength': [7, 6] }[node.expression.getText(after)];
        if (restore) {
          if (node.arguments.length !== 1 || node.arguments[0].getText(after) !== String(restore[0])) throw Error('Unexpected census edit');
          removed.push({ kind: 'NumericLiteral', reason: 'current-contract census assertion', from: restore[0], to: restore[1] });
          return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [ts.factory.createNumericLiteral(restore[1])]);
        }
      }
      return ts.visitEachChild(node, visitor, context);
    };
    return node => ts.visitNode(node, visitor);
  }]);
  const normalized = printer.printFile(transformations.transformed[0]);
  const original = printer.printFile(before);
  const equal = normalized === original;
  records.push({ file, beforeSha256: hash(beforeText), afterSha256: hash(afterText), normalizedSha256: hash(normalized), baselineNormalizedSha256: hash(original), equal, reversals: removed });
  if (!equal) {
    fs.writeFileSync(path.join(out, basename + '.normalized-mismatch.txt'), normalized, { flag: 'wx' });
    fs.writeFileSync(path.join(out, basename + '.baseline-mismatch.txt'), original, { flag: 'wx' });
    throw Error('Non-observation/assertion AST change: ' + file);
  }
  transformations.dispose();
}
const child = custody.targets[0];
const childBefore = fs.readFileSync(path.join(out, 'before', child), 'utf8');
const childAfter = fs.readFileSync(path.join(root, child), 'utf8');
const exactFunction = (file, contents, name) => parse(file, contents).statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name).getText();
for (const name of ['sameStoreShape', 'boundedRecoveryStore']) if (exactFunction(child, childBefore, name) !== exactFunction(child, childAfter, name)) throw Error('Child implementation changed: ' + name);
const repeat = custody.targets.find(file => file.endsWith('/repeat-close-contract.ts'));
const repeatText = fs.readFileSync(path.join(root, repeat), 'utf8');
const repeatSource = parse(repeat, repeatText);
const pinAssignments = [];
const inputSites = [];
const walk = node => {
  if (ts.isPropertyAssignment(node) && node.name.getText(repeatSource) === 'exactCanonicalPinnedGenesisBootstrapOperationBytes') pinAssignments.push(node.getStart(repeatSource));
  if (ts.isCallExpression(node) && node.expression.getText(repeatSource) === 'observeColdInput') inputSites.push(node.arguments[1].text);
  ts.forEachChild(node, walk);
};
walk(repeatSource);
if (pinAssignments.length !== 0 || JSON.stringify(inputSites) !== JSON.stringify(['current-successor', 'epoch-two'])) throw Error('Cold input correction escaped RED');
const result = { records, normalizedAstEquivalentOutsideEnumeratedRedHunks: true, commentsAndFormattingExcludedFromAstComparison: true, childImplementationByteIdentical: ['sameStoreShape', 'boundedRecoveryStore'], bothColdInputsUnchanged: true, coldPinAssignments: pinAssignments.length, observedSites: inputSites, currentSuccessorProvenance: 'static-only; no runtime observation or new callback API claimed', epochTwoProvenance: 'dynamic assertion written but not yet executed', testExecutions: 0, productionEdits: 0 };
fs.writeFileSync(path.join(out, 'equivalence.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ owners: records.length, equivalent: records.every(record => record.equal), childImplementationByteIdentical: true, bothColdInputsUnchanged: true, testsExecuted: 0 }));
