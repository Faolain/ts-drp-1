import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),curves=fs.realpathSync(path.join(root,'node_modules/@noble/curves/utils.js')),hashUtils=createRequire(curves).resolve('@noble/hashes/utils.js');
if(!hashUtils.startsWith(root+'/node_modules/.pnpm/@noble+hashes@2.2.0/'))throw Error('Unexpected dependency identity');
const ranges=[
['tests/genesis-profile.test.ts',108,131],
['tests/fixtures/phase-3b-v3/certified-genesis-contract.ts',9,26],
['tests/fixtures/phase-3b-v3/certified-genesis-contract.ts',178,191],
['tests/phase-5d-pacemaker-red.test.ts',139,157],
['tests/phase-5d-pacemaker-red.test.ts',365,383],
['tests/fixtures/phase-5d-v3/pacemaker-types.ts',114,133],
['tests/fixtures/phase-5d-v3/pacemaker-fixture.ts',116,125],
['node_modules/@noble/curves/abstract/edwards.d.ts',151,163],
['node_modules/@noble/curves/abstract/edwards.js',585,600],
['node_modules/@noble/curves/utils.js',1,22]
];
const excerpts=ranges.map(([f,start,end])=>{const file=path.join(root,f),bytes=fs.readFileSync(file),text=bytes.toString();return{file:f,physical:fs.realpathSync(file),sha256:hash(bytes),startLine:start,endLine:end,text:text.split('\n').slice(start-1,end).join('\n')}});
const bytes=fs.readFileSync(hashUtils),text=bytes.toString(),at=text.indexOf('function abytes('),end=text.indexOf('\n}',at)+2;
if(at<0||end<at)throw Error('Dependency source seam missing');
excerpts.push({file:hashUtils,physical:fs.realpathSync(hashUtils),sha256:hash(bytes),text:text.slice(at,end)});
const matrix=JSON.parse(fs.readFileSync(path.join(out,'matrix-validation.json')));
if(matrix.additionalCount!==2||matrix.knownFixtureCount!==7||matrix.knownGridCount!==1)throw Error('Unexpected additions');
const result={classification:'STOP_SHARED_FIXTURE_SOURCE_ATTRIBUTION',additionalDiagnostics:matrix.additionalDiagnostics,knownFixtureDiagnostics:7,separateGridDiagnostic:1,dependencyVersion:'@noble/curves2.2.0 / @noble/hashes2.2.0',excerpts,findings:[
{owner:'tests/genesis-profile.test.ts',cause:'Certificate row publicKey is a hex string; installed noble declaration and runtime abytes require 32-byte Uint8Array.',notTypeOnly:true,prospectiveMinimalRepair:'Decode that same row.publicKey hex to bytes at the one existing verify argument; preserve signature/message, strict zip215:false, and assertions.',boundary:'Outside frozen three type annotations. No cast-only disguise, dependency change or authentication weakening; root must freeze scope before edit.',runtimeFailureMeasured:false},
{owner:'tests/phase-5d-pacemaker-red.test.ts',cause:'structuredClone preserves the declared ItfTrace type, including readonly states, although this detached clone is deliberately mutated.',notTypeOnly:false,prospectiveMinimalRepair:'Localized mutable array type view at the detached clone mutation, preserving all fields and durableRevision:-1.',boundary:'Do not change readTrace/shared ItfTrace, checked traces, hash manifest, parser, mutant value or TRACE_STATE_MISMATCH assertions.'}
],initialDiagnosticCorrections:['Read-only custody-key node-e had an extra closing brace; corrected inspection succeeded before compiler execution.','Initial dependency resolver used the logical symlink importer path and reached a parent installation; corrected source-only resolver uses fs.realpathSync(curves utils) and the actual repository pnpm hashes2.2.0 path. No dependency function, test or compiler was rerun.'],sourceEdits:0,compilerReruns:0,runtimeExecutions:0};
fs.writeFileSync(path.join(out,'additional-attribution.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({additional:2,sourceOnly:true,sourceExcerpts:excerpts.length,noEdits:true,noRuntime:true}));
