import type { BrowserRouting } from "../src/browser-routing/index.js";

declare const routing: BrowserRouting;
declare const signal: AbortSignal;

void routing.findPeer("QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN", signal);

// Publication is structurally unavailable in browser routing.
// @ts-expect-error BrowserRouting intentionally has no provide member.
void routing.provide("bafkreigh2akiscaildcuxp5g4t5s6xrk5g3w7i7xvq5y5u5h5gj5f3f6aa", signal);
