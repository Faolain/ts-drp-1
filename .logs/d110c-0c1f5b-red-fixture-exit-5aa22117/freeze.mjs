import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ts from '/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/typescript/lib/typescript.js';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),read=f=>fs.readFileSync(path.join(root,f),'utf8'),write=(f,d)=>fs.writeFileSync(path.join(out,f),JSON.stringify(d,null,2)+'\n',{flag:'wx'});
const reports=[
{file:'tests/phase-5a-c-seal-safety-red.test.ts',count:7,report:'.logs/d110c-0c1f5b-green-finality-140a3053/focused.json',commit:'840ced5b7e5dd35567f6a33bd672a4bd7a03e3db'},
{file:'tests/phase-5d-pacemaker-red.test.ts',count:13,report:'.logs/d110c-0a-green-0b7a1cf6/retained-corrected-vitest.json',commit:'93fe946abf33f052706343e2aa8c02a514f98627'},
{file:'tests/phase-3g-v3-room-rebase-red.test.ts',count:20,report:'.logs/d110c-0c1f5b-green-room-mocks-4e669b70/focused.json',commit:'262e0096056bff29d52633469aec011c77e9c758'}
];
const entries=[],evidence=[];
for(const row of reports){const bytes=read(row.report),report=JSON.parse(bytes),suite=report.testResults.filter(s=>path.basename(s.name)===path.basename(row.file));if(suite.length!==1||suite[0].assertionResults.length!==row.count||suite[0].assertionResults.some(t=>t.status!=='passed'))throw Error('Accepted report differs '+row.file);if(hash(execFileSync('git',['show',row.commit+':'+row.report],{cwd:root,maxBuffer:64*1024*1024}))!==hash(bytes))throw Error('Signed report differs');entries.push(...suite[0].assertionResults.map(t=>({file:row.file,title:t.title,fullName:t.fullName,ancestorTitles:t.ancestorTitles,priorStatus:t.status,origin:'accepted-reporter'})));evidence.push({...row,sha256:hash(bytes)})}
const genesis='tests/genesis-profile.test.ts',certificate='tests/fixtures/phase-3b-v3/certified-genesis-contract.ts',room='tests/phase-3g-v3-room-rebase-red.test.ts',files=[genesis,...reports.map(r=>r.file),certificate,'tests/fixtures/phase-5d-v3/pacemaker-fixture.ts'],sources=[],spans=[];
const tree=n=>({kind:ts.SyntaxKind[n.kind],leaf:n.getChildCount()===0?n.getText():undefined,children:n.getChildren().map(tree)});
for(const file of files){const text=read(file),unit=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),assertions=[],sourceTitles=[];
if(unit.parseDiagnostics.length)throw Error('Source syntax '+file);
function visit(n){if(ts.isExpressionStatement(n)&&/^(?:await )?(?:expect|assert)/.test(n.getText(unit)))assertions.push({start:n.getStart(unit),end:n.end,text:n.getText(unit),tree:tree(n)});if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='it'&&n.arguments[0]&&ts.isStringLiteral(n.arguments[0]))sourceTitles.push(n.arguments[0].text);
if(file===certificate&&ts.isFunctionDeclaration(n)&&n.name?.text==='installInput'){if(!n.type)throw Error('Missing return annotation');spans.push({file,owner:'installInput return annotation',start:n.type.getStart(unit),end:n.type.end,text:n.type.getText(unit)});}
if(file===room&&ts.isPropertySignature(n)&&n.name?.getText(unit)==='currentEpochOperations'&&n.type){spans.push({file,owner:'projection callback currentEpochOperations annotation',start:n.type.getStart(unit),end:n.type.end,text:n.type.getText(unit)});}
ts.forEachChild(n,visit)}visit(unit);
const own=spans.filter(s=>s.file===file).sort((a,b)=>b.start-a.start);let masked=text;for(const span of own)masked=masked.slice(0,span.start)+'<AUTHORIZED_TYPE_ANNOTATION>'+masked.slice(span.end);
sources.push({file,sha256:hash(text),bytes:Buffer.byteLength(text),sourceTitles,assertionStatements:assertions,assertionStatementCount:assertions.length,outsideAuthorizedTypesSha256:hash(masked),snapshot:path.basename(file)+'.before'});
if(file===genesis){if(sourceTitles.length!==9)throw Error('Genesis count');for(const selected of [genesis,certificate,'packages/protocol-v3/src/public.ts'])if(hash(execFileSync('git',['show','57e125cd821d2bf23246376547140fe3f73447ec:'+selected],{cwd:root}))!==hash(read(selected)))throw Error('Genesis signed-source drift');entries.push(...sourceTitles.map(title=>({file,title,origin:'current-source-and-signed-closure-not-raw-reporter',historicalAcceptedStatus:'passed'})));}
}
if(spans.length!==3||entries.length!==49)throw Error('Frozen scope/count differs');
const planFile='docs/production-hardening/production-hardening-tdd-plan-v2.md',plan=read(planFile),start=plan.indexOf('### D.93.42.1 Phase 3b signed closure checkpoint'),end=plan.indexOf('\n## D.93.43',start);
write('frozen-baseline.json',{files:4,total:49,entries,evidence,genesisAcceptance:{commit:'57e125cd821d2bf23246376547140fe3f73447ec',planFile,planSha256:hash(plan),section:plan.slice(start,end),historicalCount:9,originalRawReporterLocated:false,noInventedRawReporter:true},sources,authorizedSpans:spans,noSourceChanges:true,astParsingOnly:true,compilerProgramsCreated:0,runtimeExecutions:0,collectionExecutions:0});
console.log(JSON.stringify({files:4,titles:49,sourceSnapshots:6,authorizedSpans:spans.length,assertionStatements:sources.map(s=>({file:s.file,count:s.assertionStatementCount})),runtimeExecutions:0}));
