import type { RendezvousDirectory } from "@ts-drp/rendezvous";

import type { DRPNode } from "../src/index.js";

declare const node: DRPNode;

const rendezvous: RendezvousDirectory | undefined = node.rendezvous;
void rendezvous;
