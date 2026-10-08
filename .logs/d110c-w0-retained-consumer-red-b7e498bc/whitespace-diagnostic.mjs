import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/typescript/lib/typescript.js';
const out = path.dirname(new URL(import.meta.url).pathname);
const naiveTokens = file => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, fs.readFileSync(path.join(out, file), 'utf8'));
  const result = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) result.push({ kind: ts.SyntaxKind[kind], text: scanner.getTokenText() });
  return result;
};
const tokens = file => {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(out, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length !== 0) throw Error('Parse diagnostics in equivalence text');
  const result = [];
  const visit = node => {
    if (node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) result.push({ kind: ts.SyntaxKind[node.kind], text: node.getText(source) });
    } else for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return result;
};
const baseline = tokens('repeat-close-contract.ts.baseline-mismatch.txt');
const normalized = tokens('repeat-close-contract.ts.normalized-mismatch.txt');
if (JSON.stringify(baseline) !== JSON.stringify(normalized)) throw Error('Non-whitespace token difference');
const naiveBefore = naiveTokens('repeat-close-contract.ts.baseline-mismatch.txt');
const naiveAfter = naiveTokens('repeat-close-contract.ts.normalized-mismatch.txt');
const naiveMismatch = naiveBefore.findIndex((token, index) => JSON.stringify(token) !== JSON.stringify(naiveAfter[index]));
const result = { tokens: baseline.length, tokenKindAndTextByteEquivalent: true, tokenInventorySha256: crypto.createHash('sha256').update(JSON.stringify(baseline)).digest('hex'), parserAwareTokens: true, naiveScannerFailure: { index: naiveMismatch, baselineKind: naiveBefore[naiveMismatch]?.kind, normalizedKind: naiveAfter[naiveMismatch]?.kind, baselineTextBytes: naiveBefore[naiveMismatch]?.text.length, normalizedTextBytes: naiveAfter[naiveMismatch]?.text.length, reason: 'A bare scanner lacks parser-directed template rescans and incorrectly captures source layout inside a spanning template token. Parse-directed lexical leaves compare equal.' }, diagnosis: 'TypeScript printer retained source line-break layout only; strict canonical formatting of both sides is justified.', testExecutions: 0 };
fs.writeFileSync(path.join(out, 'whitespace-diagnostic.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result));
