import type { IDRP, IDRPObject, Vertex } from "@ts-drp/types";

import type { AuthenticatedVertex, DRPVertexApplier } from "../src/drp-applier.js";
import { authenticateVertices } from "../src/index.js";
// The brand is internal/module-only. Public callers can infer verifier output,
// but cannot import and forge the capability from the package root.
// @ts-expect-error AuthenticatedVertex is deliberately not a package-root export.
import type { AuthenticatedVertex as PublicAuthenticatedVertex } from "../src/index.js";

declare const authenticated: AuthenticatedVertex;
declare const authenticatedBatch: AuthenticatedVertex[];
declare const raw: Vertex;
declare const rawBatch: Vertex[];
declare const object: IDRPObject<IDRP>;
declare const applier: DRPVertexApplier<IDRP>;

const vertex: Vertex = authenticated;
const vertices: Vertex[] = authenticatedBatch;
const verified: AuthenticatedVertex[] = authenticateVertices(rawBatch);

// Additive compatibility: existing public callers may still submit protobuf
// vertices; the public object boundary performs runtime verification itself.
void object.applyVertices(rawBatch);
void object.merge(rawBatch);
void applier.applyVertices(authenticatedBatch);

// @ts-expect-error The private applier accepts verifier-issued vertices only.
void applier.applyVertices(rawBatch);

// The only constructor for this nominal capability is the runtime verifier.
// @ts-expect-error A raw protobuf vertex has not crossed authentication.
const forged: AuthenticatedVertex = raw;

void vertex;
void vertices;
void verified;
void forged;
void (undefined as unknown as PublicAuthenticatedVertex);
