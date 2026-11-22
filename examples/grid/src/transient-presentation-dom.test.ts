import { afterEach, describe, expect, it, vi } from "vitest";
import { createZonePresentation, renderTransientZone, renderZone } from "./render";
import type { ZoneSnapshot, ZoneTransientSnapshot } from "./v3-zone";

// Exercise the actual renderer with a minimal controlled DOM. Real browser
// layout, event-loop latency and frame pacing remain the existing browser gate.
class Element {
	children: Element[] = [];
	parent: Element | undefined;
	dataset: Record<string, string> = {};
	style: Record<string, string> = {};
	textContent = "";
	title = "";
	replacements = 0;
	appendChild(element: Element): Element {
		element.remove(); this.children.push(element); element.parent = this; return element;
	}
	remove(): void {
		if (this.parent !== undefined) this.parent.children.splice(this.parent.children.indexOf(this), 1);
		this.parent = undefined;
	}
	replaceChildren(...elements: Element[]): void {
		this.replacements++;
		for (const child of [...this.children]) child.remove();
		for (const element of elements) this.appendChild(element);
	}
}
class Div extends Element {}
function fixture() {
	const grid = new Div();
	vi.stubGlobal("HTMLElement", Element); vi.stubGlobal("HTMLDivElement", Div);
	vi.stubGlobal("HTMLButtonElement", class extends Element {});
	vi.stubGlobal("document", { getElementById: (id: string) => id === "grid" ? grid : null,
		createElement: (tag: string) => tag === "div" ? new Div() : new Element() });
	const snapshot = (positions: ZoneSnapshot["transientPositions"] = {}, blocks: ZoneSnapshot["blocks"] = [{ id: "one", kind: "wall", x: 1, y: 2 }],
		zoneId = "room", ready = true): ZoneSnapshot => ({ ready, zoneId, blocks, transientPositions: positions,
		transportPeerAuthors: [], fabricTrials: [], aoiBandwidth: {}, aoiProjection: {}, tradeIntent: { status: "absent" } } as unknown as ZoneSnapshot);
	const find = (key: string, value: string) => grid.children.find(element => element.dataset[key] === value);
	const requests = new Map<number, FrameRequestCallback>(), cancelled = new Set<number>(); let next = 0;
	const presentation = createZonePresentation(callback => { requests.set(++next, callback); return next; }, handle => { cancelled.add(handle); });
	const flush = (handle = next) => { const callback = requests.get(handle); requests.delete(handle); callback?.(0); };
	return { grid, snapshot, find, presentation, requests, cancelled, flush, last: () => next };
}
afterEach(() => vi.unstubAllGlobals());

describe("Grid transient DOM consumer", () => {
	it("keeps block and peer elements stable while positions change, and removes only absent elements", () => {
		const f = fixture(); renderZone(f.snapshot({ alice: { x: 0, y: 0 } }));
		const block = f.find("blockId", "one")!, peer = f.find("glowingPeerId", "alice")!, replacements = f.grid.replacements;
		for (let x = 1; x < 8; x++) renderTransientZone(f.snapshot({ alice: { x, y: -2 } }));
		expect(f.find("blockId", "one")).toBe(block); expect(f.find("glowingPeerId", "alice")).toBe(peer);
		expect(peer.style.left).toBe("calc(50% + 168px)"); expect(peer.style.top).toBe("calc(50% - -48px)");
		expect(f.grid.replacements).toBe(replacements); expect(f.grid.children).toHaveLength(2);
		renderZone(f.snapshot({ alice: { x: 7, y: -2 } }, [{ id: "one", kind: "tree", x: 9, y: 4 }]));
		expect(f.find("blockId", "one")).toBe(block); expect(block.textContent).toBe("tree (9, 4)");
		renderZone(f.snapshot({}, [])); expect(f.grid.children).toHaveLength(0);
	});

	it("schedules one latest transient visual frame without collapsing full projections", () => {
		const f = fixture(); f.presentation.projection(f.snapshot());
		for (let x = 1; x <= 20; x++) f.presentation.transient(f.snapshot({ alice: { x, y: 0 } }));
		expect(f.requests.size).toBe(1); expect(f.find("glowingPeerId", "alice")).toBeUndefined();
		f.flush(); expect(f.find("glowingPeerId", "alice")!.style.left).toBe("calc(50% + 480px)");
		f.presentation.projection(f.snapshot({}, [{ id: "one", kind: "first", x: 2, y: 0 }]));
		expect(f.find("blockId", "one")!.textContent).toBe("first (2, 0)");
		f.presentation.projection(f.snapshot({}, [{ id: "one", kind: "second", x: 3, y: 0 }]));
		expect(f.find("blockId", "one")!.textContent).toBe("second (3, 0)");
	});

	it("cancels stale queued overlays on full updates, same-room close/reopen, foreign room and terminal UI release", () => {
		const f = fixture(); f.presentation.projection(f.snapshot());
		f.presentation.transient(f.snapshot({ old: { x: 50, y: 0 } })); const old = f.last();
		f.presentation.projection(f.snapshot({}, [], "room", false));
		f.presentation.projection(f.snapshot({}, [], "room", true));
		expect(f.cancelled.has(old)).toBe(true); f.flush(old); expect(f.find("glowingPeerId", "old")).toBeUndefined();
		f.presentation.transient(f.snapshot({ foreign: { x: 9, y: 0 } }, [], "foreign")); expect(f.last()).toBe(old);
		f.presentation.transient(f.snapshot({ next: { x: 2, y: 0 } })); const pending = f.last();
		f.presentation.close(); f.flush(pending); expect(f.find("glowingPeerId", "next")).toBeUndefined();
		f.presentation.projection(f.snapshot({ after: { x: 8, y: 0 } })); expect(f.grid.children).toHaveLength(0);
	});
});
