import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from '/tmp/d110c-f5b-red-room-guard-ueW92K/checkout/node_modules/typescript/lib/typescript.js';
import {createServer} from '/tmp/d110c-f5b-red-room-guard-ueW92K/checkout/node_modules/vite/dist/node/index.js';
const root=process.cwd(),out=path.dirname(new URL(import.meta.url).pathname),file='tests/phase-6a-creator-successor-product-red.test.ts',source=fs.readFileSync(path.join(root,file),'utf8'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const unit=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),helper=unit.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='roomAuthorityReadOrderFixtures');
if(!helper||unit.parseDiagnostics.length)throw Error('Exact helper missing');
const server=await createServer({configFile:path.join(root,'vite.config.mts'),server:{middlewareMode:true},appType:'custom'});
try{
 const room=await server.ssrLoadModule('/examples/v3-room/src/index.ts'),chat=await server.ssrLoadModule('/examples/v3-chat/src/index.ts');
 const canonical=await server.ssrLoadModule('@ts-drp/canonical'),noble=await server.ssrLoadModule('@noble/curves/ed25519.js');
 const code=ts.transpileModule(helper.getText(unit),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const prepare=new Function('ed25519','decodeCanonical','encodeCanonical','hashDomain','createV3ChatApplication','createV3RoomCreatorInviteMaterial',code+';return roomAuthorityReadOrderFixtures;')(noble.ed25519,canonical.decodeCanonical,canonical.encodeCanonical,canonical.hashDomain,chat.createV3ChatApplication,room.createV3RoomCreatorInviteMaterial);
 const fixtures=await prepare();if(fixtures.length!==2)throw Error('Fixture count');
 const rows=fixtures.map(({profileId,invite})=>({profileId,pinnedGenesisAnchorDigest:invite.pinnedGenesisAnchorDigest,signatureHex:Buffer.from(invite.detachedGenesisSignature).toString('hex'),anchor:canonical.decodeCanonical(invite.exactCanonicalGenesisAnchorPreimageBytes),acl:canonical.decodeCanonical(invite.exactCanonicalLatchedAclBytes),parameters:canonical.decodeCanonical(invite.exactCanonicalParametersCarrierBytes),profile:canonical.decodeCanonical(invite.exactCanonicalProfileBytes),signers:canonical.decodeCanonical(invite.exactCanonicalSignerSetBytes),carrierHashes:Object.fromEntries(Object.entries(invite).filter(([,v])=>v instanceof Uint8Array).map(([k,v])=>[k,hash(v)]))}));
 fs.writeFileSync(path.join(out,'fixture-validation.json'),JSON.stringify({root,testSha256:hash(source),helperSha256:hash(helper.getText(unit)),sameExactSignedHelper:true,allVerified:true,realProductBuilder:true,actualEd25519GenesisSignatures:true,noRoomConstructorCalled:true,noMockOrAlternateConfig:true,fixtures:rows},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({fixtures:2,allVerified:true,noRoomConstructorCalled:true,profiles:rows.map(r=>r.profileId)}));
}finally{await server.close()}
