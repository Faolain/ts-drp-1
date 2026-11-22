function reject(message) {
  throw message;
}
function canonicalValue(value) {
  return value;
}
function isSafeInteger(value) {
  return typeof value === "number" && value % 1 === 0 && value >= -9007199254740991 && value <= 9007199254740991;
}
function isCanonicalBytes(value) {
  return value !== null && typeof value === "object" && typeof value.subarray === "function";
}
function isCanonicalArray(value) {
  if (value === null || typeof value !== "object" || isCanonicalBytes(value)) return false;
  let count = 0;
  for (const key in value) {
    if (key !== "" + count) return false;
    count += 1;
  }
  return count === value.length;
}
function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || isCanonicalArray(value) || isCanonicalBytes(value)) return false;
  let count = 0;
  for (const key in value) {
    if (!keys.includes(key)) return false;
    count += 1;
  }
  return count === keys.length;
}
function identitySet() {
  const values = [];
  return {
    has: (value) => values.includes(value),
    add: (value) => {
      values.push(value);
    }
  };
}
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function blockValue(value, operation) {
  if (!exactKeys(value, operation ? ["action", "id", "kind", "x", "y"] : ["id", "kind", "x", "y"])) return void 0;
  if (operation && value.action !== "placeBlock" || typeof value.id !== "string" || value.id.length === 0 || typeof value.kind !== "string" || value.kind.length === 0 || !isSafeInteger(value.x) || !isSafeInteger(value.y))
    return void 0;
  return canonicalValue({ id: value.id, kind: value.kind, x: value.x, y: value.y });
}
function outcomeValue(value) {
  if (!exactKeys(value, ["action", "proof"]) || value.action !== "commit-outcome-v1") return void 0;
  const proof = value.proof;
  if (!exactKeys(proof, [
    "action",
    "approvals",
    "clientOperationId",
    "exactCanonicalIntentBytes",
    "exactCanonicalPayloadBytes"
  ]) || proof.action !== "commit-outcome-v1" || typeof proof.clientOperationId !== "string" || proof.clientOperationId.length === 0 || !isCanonicalBytes(proof.exactCanonicalIntentBytes) || !isCanonicalBytes(proof.exactCanonicalPayloadBytes) || !isCanonicalArray(proof.approvals) || proof.approvals.length !== 2)
    return void 0;
  const approvals = [];
  for (const approval of proof.approvals) {
    if (!exactKeys(approval, ["signature", "signer"]) || typeof approval.signer !== "string" || !/^[0-9a-f]{64}$/u.test(approval.signer) || !isCanonicalBytes(approval.signature) || approval.signature.length !== 64)
      return void 0;
    approvals.push(canonicalValue({ signer: approval.signer, signature: approval.signature.slice() }));
  }
  approvals.sort((left, right) => compareText(left.signer, right.signer));
  if (approvals[0].signer === approvals[1].signer) return void 0;
  return canonicalValue({
    action: "commit-outcome-v1",
    proof: canonicalValue({
      action: "commit-outcome-v1",
      approvals: canonicalValue(approvals),
      clientOperationId: proof.clientOperationId,
      exactCanonicalIntentBytes: proof.exactCanonicalIntentBytes.slice(),
      exactCanonicalPayloadBytes: proof.exactCanonicalPayloadBytes.slice()
    })
  });
}
function createZoneStateKernel(creatorAuthor, creatorPeerId) {
  if (typeof creatorAuthor !== "string" || !/^[0-9a-f]{64}$/u.test(creatorAuthor) || typeof creatorPeerId !== "string" || creatorPeerId.length === 0) {
    reject("v3 zone creator identity is invalid");
  }
  function rosterValue(value) {
    if (!isCanonicalArray(value) || value.length === 0) return void 0;
    const entries = [];
    const authors = identitySet();
    const peers = identitySet();
    const orders = identitySet();
    for (const member of value) {
      if (!exactKeys(member, ["author", "peerId", "order"]) || typeof member.author !== "string" || !/^[0-9a-f]{64}$/u.test(member.author) || typeof member.peerId !== "string" || member.peerId.length === 0 || !isSafeInteger(member.order) || member.order < 0 || authors.has(member.author) || peers.has(member.peerId) || orders.has(member.order))
        return void 0;
      authors.add(member.author);
      peers.add(member.peerId);
      orders.add(member.order);
      entries.push(canonicalValue({ author: member.author, peerId: member.peerId, order: member.order }));
    }
    entries.sort((left, right) => left.order - right.order);
    return entries[0].order === 0 && entries[0].author === creatorAuthor && entries[0].peerId === creatorPeerId ? canonicalValue(entries) : void 0;
  }
  function apply(state, operation, author) {
    if (!exactKeys(state, ["version", "creatorAuthor", "creatorPeerId", "blocks", "outcomes", "roster"]) || state.version !== 2 || !isCanonicalArray(state.blocks) || !isCanonicalArray(state.outcomes) || !isCanonicalArray(state.roster) || operation === null || typeof operation !== "object" || isCanonicalArray(operation))
      reject("v3 zone projection state is invalid");
    const action = operation.action;
    if (action === "join" || action === "causalJoin" || action === "$drp.author-fence.v1") {
      return canonicalValue({ state, output: null });
    }
    if (action === "installRoster") {
      if (typeof author !== "string" || !/^[0-9a-f]{64}$/u.test(author))
        reject("v3 zone execution context is unavailable");
      if (author !== creatorAuthor) return canonicalValue({ state, output: operation });
      if (!exactKeys(operation, ["action", "roster"]) || !exactKeys(operation.roster, ["entries"])) {
        reject("v3 zone roster conflicts");
      }
      const roster = rosterValue(operation.roster.entries);
      if (roster === void 0 || state.roster.length !== 0 && (state.roster.length !== roster.length || state.roster.some(
        (member, index) => member.author !== roster[index].author || member.peerId !== roster[index].peerId || member.order !== roster[index].order
      )))
        reject("v3 zone roster conflicts");
      return canonicalValue({ state: canonicalValue({ ...state, roster }), output: operation });
    }
    if (action === "placeBlock") {
      const block = blockValue(operation, true);
      if (block === void 0) reject("v3 zone placeBlock operation is invalid");
      const blocks = state.blocks.filter((existing) => existing.id !== block.id);
      blocks.push(block);
      blocks.sort((left, right) => compareText(left.id, right.id));
      return canonicalValue({ state: canonicalValue({ ...state, blocks: canonicalValue(blocks) }), output: operation });
    }
    if (action === "commit-outcome-v1") {
      const outcome = outcomeValue(operation);
      if (outcome === void 0) reject("v3 zone outcome proof is invalid");
      if (state.outcomes.some((existing) => existing.proof.clientOperationId === outcome.proof.clientOperationId)) {
        reject("v3 zone outcome identity conflicts");
      }
      return canonicalValue({
        state: canonicalValue({ ...state, outcomes: canonicalValue([...state.outcomes, outcome]) }),
        output: outcome
      });
    }
    if (action === "applicationBatch") {
      if (!exactKeys(operation, ["action", "batch"]) || !exactKeys(operation.batch, ["entries", "version"]) || operation.batch.version !== 1 || !isCanonicalArray(operation.batch.entries) || operation.batch.entries.length < 2 || operation.batch.entries.length > 16)
        reject("invalid application batch");
      let prior = -1;
      let next = state;
      const output = [];
      for (const entry of operation.batch.entries) {
        if (!exactKeys(entry, ["logicalTime", "operation"]) || !isSafeInteger(entry.logicalTime) || entry.logicalTime < 0 || entry.logicalTime <= prior || blockValue(entry.operation, true) === void 0)
          reject("invalid application batch entry");
        prior = entry.logicalTime;
        const result = apply(next, entry.operation, author);
        next = result.state;
        output.push(result.output);
      }
      return canonicalValue({ state: next, output: canonicalValue(output) });
    }
    if (action === "migrationRecord") {
      const keys = [
        "applicationStateDigest",
        "archivePolicy",
        "authorityKind",
        "exactCanonicalApplicationStateBytes",
        "kind",
        "rehearsalNonce",
        "sourceAcceptedOperationCount",
        "sourceAcceptedOperationsDigest",
        "sourceAnchorDigest",
        "sourceBlueprintDigest",
        "sourceCreatorAuthor",
        "sourceObjectId",
        "targetAnchorDigest",
        "targetBlueprintDigest",
        "targetCreatorAuthor",
        "targetImportOperationCount",
        "targetImportOperationsDigest",
        "targetObjectId",
        "version"
      ];
      if (!exactKeys(operation, ["action", "record"]) || !exactKeys(operation.record, keys) || operation.record.kind !== "ts-drp-v3-room-migration-record" || operation.record.version !== 1 || operation.record.archivePolicy !== "retain-source" || operation.record.authorityKind !== "creator-ed25519-registered-vertex-v1")
        reject("invalid migration record");
      return canonicalValue({ state, output: null });
    }
    if (action === "migrationActivation") {
      if (!exactKeys(operation, ["action", "decision"]) || operation.decision === null || typeof operation.decision !== "object" || isCanonicalArray(operation.decision)) {
        reject("invalid migration activation");
      }
      return canonicalValue({ state, output: null });
    }
    reject("v3 zone operation is invalid");
  }
  return { apply };
}
function applicationBatchReducer(input) {
  return zoneReducer(input);
}
function causalJoinReducer(input) {
  return zoneReducer(input);
}
function commitOutcomeReducer(input) {
  return zoneReducer(input);
}
function installRosterReducer(input) {
  return zoneReducer(input);
}
function migrationActivationReducer(input) {
  return zoneReducer(input);
}
function migrationRecordReducer(input) {
  return zoneReducer(input);
}
function placeBlockReducer(input) {
  return zoneReducer(input);
}
function zoneReducer(input) {
  const state = input.state;
  if (state === null || typeof state !== "object") reject("v3 zone projection state is invalid");
  return createZoneStateKernel(state.creatorAuthor, state.creatorPeerId).apply(
    state,
    input.operation,
    input.executionContext?.author
  );
}
export const blueprint = {
  exportSchemaVersion: 1,
  artifactId: "v3-zone.v2",
  runtimeProfile: "ecmascript-2024-sync-v1",
  reducers: { "applicationBatch": applicationBatchReducer, "causalJoin": causalJoinReducer, "commit-outcome-v1": commitOutcomeReducer, "installRoster": installRosterReducer, "migrationActivation": migrationActivationReducer, "migrationRecord": migrationRecordReducer, "placeBlock": placeBlockReducer }
};
