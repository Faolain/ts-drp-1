import {readFileSync} from "node:fs";
import {compareBytes, encodeCanonical} from "@ts-drp/canonical";
import * as ts from "typescript";
import {describe, expect, it, vi} from "vitest";

// Existing private-owner extraction: these are selection/byte-equality controls,
// not native reservations, signature authority or admission acceptance.
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("rollback.ts", source, ts.ScriptTarget.Latest, true);
const owner = tree.statements.find((node): node is ts.FunctionDeclaration =>
	ts.isFunctionDeclaration(node) && node.name?.text === "creatorOrdinaryNativeIssuedCorresponds");
if (owner === undefined) throw Error("missing original native correspondence owner");
function fixture() {
	const equal = vi.fn((left: unknown, right: unknown) => compareBytes(encodeCanonical(left), encodeCanonical(right)) === 0);
	const code = ts.transpileModule(owner!.getText(tree), {
		compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
	}).outputText;
	const corresponds = new Function("closedRetirementEqual", "compareBytes", code + "\nreturn creatorOrdinaryNativeIssuedCorresponds;")(equal, compareBytes);
	return {equal, corresponds, checkNew: vi.fn((_row: ReturnType<typeof row>) => true)};
}
function row(sequence: number, author = "alice") {
	return {objectId: "room", author, authorSequence: sequence, canonicalPreimageBytes: Uint8Array.of(sequence, 1),
		digest: Uint8Array.of(sequence, 2), signature: Uint8Array.of(sequence, 3)};
}
function image(issued = [row(0)]) {
	return {issued, outbox: issued.map(value => ({objectId: value.objectId, author: value.author,
		authorSequence: value.authorSequence, digest: value.digest.slice(), publishState: "pending"})), lineages: [], plans: []};
}
describe("ordinary fresh native exact-address correspondence", () => {
	it("compares complete old records once and authenticates only genuinely new addresses", () => {
		const f = fixture(), prior = image(Array.from({length: 64}, (_, index) => row(index))),
			present = image([...prior.issued].reverse().concat([row(64), row(65)]));
		expect(f.corresponds(present, prior, "room", f.checkNew)).toBe(true);
		expect(f.equal).toHaveBeenCalledTimes(64);
		for (const [actual, old] of f.equal.mock.calls)
			expect((actual as ReturnType<typeof row>).authorSequence).toBe((old as ReturnType<typeof row>).authorSequence);
		expect(f.checkNew.mock.calls.map(call => (call[0] as ReturnType<typeof row>)?.authorSequence)).toEqual([64, 65]);
	});
	it.each(["canonicalPreimageBytes", "digest", "signature", "extra-field"] as const)(
		"never treats changed historical %s as newly authorizable work", field => {
			const f = fixture(), prior = image(), present = image([row(0)]);
			if (field === "extra-field") Reflect.set(present.issued[0]!, "extra", "changed");
			else present.issued[0]![field][0] = 99;
			expect(f.corresponds(present, prior, "room", f.checkNew)).toBe(false);
			expect(f.checkNew).not.toHaveBeenCalled();
		});
	it.each(["old", "current", "outbox"] as const)("refuses duplicate %s addresses", which => {
		const f = fixture(), prior = image(), present = image();
		if (which === "old") prior.issued.push(row(0));
		if (which === "current") present.issued.push(row(0));
		if (which === "outbox") present.outbox.push({...present.outbox[0]!});
		expect(f.corresponds(present, prior, "room", f.checkNew)).toBe(false);
	});
	it("refuses missing history, foreign contexts and malformed addresses", () => {
		for (const change of ["missing", "object", "author", "sequence"] as const) {
			const f = fixture(), prior = image(), present = image();
			if (change === "missing") present.issued.length = 0;
			if (change === "object") present.issued[0]!.objectId = "foreign";
			if (change === "author") present.issued[0]!.author = "";
			if (change === "sequence") present.issued[0]!.authorSequence = NaN;
			expect(f.corresponds(present, prior, "room", f.checkNew), change).toBe(false);
			expect(f.checkNew).not.toHaveBeenCalled();
		}
	});
	it("requires fresh new-row authorization and exact outbox pairing", () => {
		const f = fixture(), prior = image(), present = image([row(0), row(1)]);
		f.checkNew.mockReturnValue(false);
		expect(f.corresponds(present, prior, "room", f.checkNew)).toBe(false);
		f.checkNew.mockReturnValue(true);
		present.outbox[1]!.digest[0] = 99;
		expect(f.corresponds(present, prior, "room", f.checkNew)).toBe(false);
		present.outbox[1]!.digest = present.issued[1]!.digest.slice();
		expect(f.corresponds(present, prior, "room", f.checkNew)).toBe(true);
	});
});
