import { linearizeEpoch } from "./linearize.js";
import { stateDigest } from "./state.js";

export class FoldError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "FoldError";
    this.code = code;
  }
}

export async function foldEpoch({
  vertices,
  anchorHash,
  application,
  acl,
  authorize,
  classifyPlane = (vertex) => vertex.operation?.plane ?? "application",
  mode = "none",
  resolveConflicts,
} = {}) {
  if (!application?.snapshot || !acl?.snapshot) throw new TypeError("application and ACL state machines are required");
  const ordered = linearizeEpoch({ vertices, anchorHash, mode, resolveConflicts });
  if (typeof application.fork !== "function" || typeof acl.fork !== "function") {
    throw new TypeError("state machines must support fork() for atomic staging");
  }
  const stagedApplication = application.fork();
  const stagedAcl = acl.fork();

  // Hard-epoch rule: all authorization is evaluated against the ACL state committed
  // by the anchor. ACL mutations in this epoch become active only in the next epoch.
  const epochAuthority = acl.snapshot();
  const applied = [];
  for (const vertex of ordered) {
    const plane = classifyPlane(vertex);
    let allowed;
    try {
      allowed = authorize ? authorize(vertex, plane, epochAuthority) : true;
    } catch (error) {
      throw new FoldError("AUTHORIZATION_EXCEPTION", `authorization threw for ${vertex.hash}`, error);
    }
    if (!allowed) throw new FoldError("UNAUTHORIZED", `vertex ${vertex.hash} is not authorized by the epoch anchor ACL`);
    try {
      if (plane === "acl") stagedAcl.apply(vertex.operation, { vertex, epochAuthority });
      else if (plane === "system") {
        // Reserved system operations have no application state effect.
      } else stagedApplication.apply(vertex.operation, { vertex, epochAuthority });
      applied.push(vertex.hash);
    } catch (error) {
      if (error instanceof FoldError) throw error;
      throw new FoldError("REDUCER_EXCEPTION", `reducer threw while folding ${vertex.hash}`, error);
    }
  }

  const applicationState = stagedApplication.snapshot();
  const aclState = stagedAcl.snapshot();
  const applicationDigest = await stateDigest(applicationState);
  const aclDigest = await stateDigest(aclState);
  let adopted = false;
  return Object.freeze({
    orderedHashes: Object.freeze(applied),
    applicationState,
    aclState,
    applicationDigest,
    aclDigest,
    adopt() {
      if (adopted) return false;
      application.adopt(applicationState);
      acl.adopt(aclState);
      adopted = true;
      return true;
    },
  });
}
