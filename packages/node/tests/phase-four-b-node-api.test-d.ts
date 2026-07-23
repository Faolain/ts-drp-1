import { type DRPNode } from "@ts-drp/node";
import type { PeerCache, RendezvousEnsemble } from "@ts-drp/rendezvous";

declare const node: DRPNode;

const rendezvous: RendezvousEnsemble | undefined = node.rendezvous;
const cache: PeerCache | undefined = node.rendezvousCache;

void rendezvous;
void cache;
