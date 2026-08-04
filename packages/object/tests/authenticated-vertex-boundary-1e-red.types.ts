import type { IDRP, IDRPObject, Vertex } from "@ts-drp/types";

import { type AuthenticatedVertex, authenticateVertices } from "../src/index.js";

declare const authenticated: AuthenticatedVertex;
declare const authenticatedBatch: AuthenticatedVertex[];
declare const raw: Vertex;
declare const rawBatch: Vertex[];
declare const object: IDRPObject<IDRP>;

const vertex: Vertex = authenticated;
const vertices: Vertex[] = authenticatedBatch;
const verified: AuthenticatedVertex[] = authenticateVertices(rawBatch);

// Additive compatibility: existing public callers may still submit protobuf
// vertices; the public object boundary performs runtime verification itself.
void object.applyVertices(rawBatch);
void object.merge(rawBatch);

// The only constructor for this nominal capability is the runtime verifier.
// @ts-expect-error A raw protobuf vertex has not crossed authentication.
const forged: AuthenticatedVertex = raw;

void vertex;
void vertices;
void verified;
void forged;
