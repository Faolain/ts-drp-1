import type { DRPNode } from "@ts-drp/node";

interface BrowserRouting {
	findProviders(cid: string, signal: AbortSignal): AsyncIterable<unknown>;
}

declare const node: DRPNode;

const routing: BrowserRouting | undefined = node.routing;
void routing;
