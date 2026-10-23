import { describe, expect, it } from "vitest";
import {
	type AheGenerationPartition,
	type AheRetirementControl,
	type AheRetirementControlRead,
	type AheRetirementDomain,
	type AheRetirementPreparation,
	type StorageObjectId,
} from "@ts-drp/storage";
import {
	applyClosedEpochRetirementIntent,
	captureClosedEpochRetirementMetadataDomain,
	validateClosedEpochRetirementMetadataDomain,
	type ClosedEpochRetirementParticipantRead,
} from "../src/internal/closed-epoch-cleanup.js";

it("binds atomic row rewrites to exact prepared and completed native images", () => {
	const control = {kind: "v3-issuance-retirement-control-1", objectId: "rewrite-room", incarnation: "01".repeat(32),
		revision: 3, sequence: 2, active: null, completed: null};
	const preparation = {decisionDigest: "02".repeat(32), sourceProofDigest: "03".repeat(32), throughEpoch: 4, protectedRecords: []};
	const before = "04".repeat(32), after = "05".repeat(32);
	const domain = captureClosedEpochRetirementMetadataDomain(16, control, before, preparation, undefined, after);
	const prepared = {...control, revision: 4, sequence: 3, active: {sequence: 3, preparation}};
	const completed = {...control, revision: 5, sequence: 3, completed: preparation};
	expect(validateClosedEpochRetirementMetadataDomain(control, before, preparation, domain, undefined, after)).toBe("old");
	expect(validateClosedEpochRetirementMetadataDomain(prepared, before, preparation, domain, undefined, after)).toBe("prepared");
	expect(validateClosedEpochRetirementMetadataDomain(completed, after, preparation, domain, undefined, after)).toBe("completed");
	for (const [observed, image, projected] of [[prepared, after, after], [prepared, before, before],
		[completed, before, after], [completed, "06".repeat(32), after]] as const) {
		expect(() => validateClosedEpochRetirementMetadataDomain(observed, image, preparation, domain, undefined, projected)).toThrow();
	}
});

/** This exercises the real sequencer and native codecs. The fixture supplies
 * already authenticated participant facts; it does not claim signature/storage
 * verification. The healthy native fixture covers those independent owners. */
function fixture() {
	const objectId = `retirement-sequencing:${"a".repeat(32)}` as StorageObjectId;
	const image = "02".repeat(32), incarnation = "01".repeat(32);
	const domain = (roles: number): AheRetirementDomain => [roles, new Uint8Array(32),
		new Uint8Array(32).fill(1), 0, new Uint8Array(32).fill(2), new Uint8Array(32).fill(2), 0];
	const domains = [3, 4, 8, 16, 32, 192].map(domain);
	const head = {kind: "none" as const, objectId};
	const preparation: AheRetirementPreparation = {head, floorEpoch: 2, floorAnchor: "03".repeat(32),
		decisionDigest: "04".repeat(32), sourceProofDigest: "05".repeat(32), generationRecordDigests: [],
		snapshotScopes: [], protectedIndices: [], retireIndices: [], domains};
	const generations: AheGenerationPartition = {recordDigests: [], identities: [], protectedIndices: [], retireIndices: []};
	let coordinator: AheRetirementControl = {kind: "ahe-retirement-control-3", objectId, incarnation,
		revision: 0, sequence: 0, active: null, completed: null, binding: null, nominee: null};
	type Phase = ClosedEpochRetirementParticipantRead["phase"];
	const phases: Phase[] = domains.slice(1).map(() => "old");
	const acquired = phases.map(() => 0), released = phases.map(() => 0), effects: string[] = [];
	let coordinatorReleased = 0, verified = 0;
	let hook: ((index: number, kind: "acquire" | "prepare" | "commit" | "release", count: number) => void | Promise<void>) | undefined;
	const completed = (): AheRetirementControl => ({...coordinator, revision: 2, sequence: 1, active: null, binding: null,
		completed: {throughEpoch: 2, decisionDigest: preparation.decisionDigest, sourceProofDigest: preparation.sourceProofDigest,
			snapshotHoles: [], generationHoles: [], generationIdentities: [], domains}});
	const input = {preparation, generations,
		acquireCoordinator: async () => {
			const captured = coordinator;
			return {control: captured, imageDigest: image, head,
				prepareBound: async () => {coordinator = {...captured, revision: 1, sequence: 1,
					active: {sequence: 1, phase: "prepared", preparation}, binding: generations};
					return {ok: true, value: coordinator};},
				commitPrepared: async () => {coordinator = completed(); return {ok: true, value: coordinator};},
				release: async () => {coordinatorReleased++;},
			} as unknown as AheRetirementControlRead; // Partial stand-in: only the members sequencing uses.
		},
		participants: domains.slice(1).map((commitment, index) => ({commitment,
			acquire: async () => {
				acquired[index]!++;
				await hook?.(index, "acquire", acquired[index]!);
				const phase = phases[index]!;
				const ordinal = acquired[index]!;
				let live = true;
				const available = (): void => { if (!live) throw Error("released-native-view"); };
				return {commitment, phase,
					prepareFence: async () => {available(); await hook?.(index, "prepare", ordinal);
						expect(phases[index]).toBe(phase); effects.push(`${index}:prepare`); phases[index] = "prepared";},
					commitPrepared: async () => {available(); expect(phases[index]).toBe(phase);
						effects.push(`${index}:commit`); phases[index] = "completed"; await hook?.(index, "commit", ordinal);},
					release: async () => {if (!live) return; live = false; released[index]!++; await hook?.(index, "release", ordinal);},
				};
			}})),
		verifyCompleted: async () => {expect(phases.every(phase => phase === "completed")).toBe(true); verified++;},
	};
	return {input, acquired, released, effects, phases,
		hook(value: typeof hook) {hook = value;},
		resumePrepared() {coordinator = {...coordinator, revision: 1, sequence: 1,
			active: {sequence: 1, phase: "prepared", preparation}, binding: generations};},
		resumeCompleted() {coordinator = completed(); phases.fill("completed");},
		get coordinator() {return coordinator;}, get coordinatorReleased() {return coordinatorReleased;},
		get verified() {return verified;},
	};
}

describe("closed retirement original-view sequencing", () => {
	it("uses the independent prepared readback for same-domain commit, retaining completion readback and final scan", async () => {
		const f = fixture();
		const committedOn: number[] = [];
		f.hook((_index, kind, count) => { if (kind === "commit") committedOn.push(count); });
		await applyClosedEpochRetirementIntent(f.input);
		expect(f.acquired).toEqual([4, 4, 4, 4, 4]);
		expect(f.released).toEqual(f.acquired);
		expect(f.effects).toEqual(Array.from({length: 5}, (_, index) => [`${index}:prepare`, `${index}:commit`]).flat());
		expect(committedOn).toEqual([2, 2, 2, 2, 2]);
		expect(f.verified).toBe(1);
	});
	it("resumes exact mixed old/prepared/completed domains without replaying completed effects", async () => {
		const f = fixture(); f.resumePrepared();
		f.phases[0] = "completed"; f.phases[1] = "prepared";
		await applyClosedEpochRetirementIntent(f.input);
		expect(f.effects).not.toContain("0:prepare"); expect(f.effects).not.toContain("0:commit");
		expect(f.effects).not.toContain("1:prepare"); expect(f.effects).toContain("1:commit");
		expect(f.released).toEqual(f.acquired);
	});
	it("checks every completed native domain afresh on exact completed retry", async () => {
		const f = fixture(); f.resumeCompleted();
		await applyClosedEpochRetirementIntent(f.input);
		expect(f.acquired).toEqual([1, 1, 1, 1, 1]); expect(f.effects).toEqual([]);
		expect(f.released).toEqual(f.acquired); expect(f.verified).toBe(1);
	});
	it("preserves a lost acknowledgment after exact new readback, then permits exact retry", async () => {
		const f = fixture(); let lost = true;
		f.hook((index, kind) => {if (index === 0 && kind === "commit" && lost) {lost = false; throw Error("lost-ack");}});
		await expect(applyClosedEpochRetirementIntent(f.input)).rejects.toThrow("lost-ack");
		expect(f.phases[0]).toBe("completed"); expect(f.acquired[0]).toBe(3);
		expect(f.phases.slice(1)).toEqual(["old", "old", "old", "old"]);
		expect(f.released).toEqual(f.acquired);
		await applyClosedEpochRetirementIntent(f.input);
		expect(f.effects.filter(value => value === "0:commit")).toHaveLength(1);
		expect(f.verified).toBe(1);
	});
	it("preserves a completed/prepared/old interruption and retries only the remaining exact effects", async () => {
		const f = fixture(); f.resumePrepared(); f.phases[1] = "prepared";
		const lost = Error("same-domain-lost-ack"); let fail = true;
		f.hook((index, kind) => { if (index === 0 && kind === "commit" && fail) { fail = false; throw lost; } });
		await expect(applyClosedEpochRetirementIntent(f.input)).rejects.toBe(lost);
		expect(f.phases).toEqual(["completed", "prepared", "old", "old", "old"]);
		expect(f.effects).toEqual(["0:prepare", "0:commit"]);
		expect(f.released).toEqual(f.acquired);
		await applyClosedEpochRetirementIntent(f.input);
		expect(f.effects.filter(value => value === "0:prepare" || value === "0:commit")).toHaveLength(2);
		expect(f.effects).not.toContain("1:prepare"); expect(f.effects).toContain("1:commit");
		expect(f.released).toEqual(f.acquired); expect(f.verified).toBe(1);
	});
	it("preserves prepare lost-delivery and joins its independent readback without attempting commit", async () => {
		const f = fixture(), lost = Error("prepare-delivery"); let fail = true;
		f.hook((index, kind, ordinal) => { if (index === 0 && kind === "release" && ordinal === 1 && fail) { fail = false; throw lost; } });
		await expect(applyClosedEpochRetirementIntent(f.input)).rejects.toBe(lost);
		expect(f.phases).toEqual(["prepared", "old", "old", "old", "old"]);
		expect(f.effects).toEqual(["0:prepare"]); expect(f.acquired[0]).toBe(2);
		expect(f.released).toEqual(f.acquired);
		await applyClosedEpochRetirementIntent(f.input);
		expect(f.effects.filter(value => value === "0:prepare")).toHaveLength(1);
		expect(f.released).toEqual(f.acquired); expect(f.verified).toBe(1);
	});
	it("joins every consumed or completed read before readback, later participants or successful delivery", async () => {
		for (const ordinal of [1, 2, 3, 4]) {
			const f = fixture(); let entered!: () => void, resume!: () => void;
			const started = new Promise<void>(resolve => { entered = resolve; });
			const gate = new Promise<void>(resolve => { resume = resolve; });
			f.hook(async (index, kind, count) => { if (index === 0 && kind === "release" && count === ordinal) { entered(); await gate; } });
			let finished = false;
			const pending = applyClosedEpochRetirementIntent(f.input).then(value => { finished = true; return value; });
			await started;
			expect(finished).toBe(false); expect(f.acquired[0]).toBe(ordinal);
			if (ordinal < 4) expect(f.acquired.slice(1)).toEqual([0, 0, 0, 0]);
			resume(); await pending;
			expect(f.released).toEqual(f.acquired); expect(f.verified).toBe(1);
		}
	});
	it("aggregates independent readback failure with the original commit lost delivery", async () => {
		const f = fixture(), lost = Error("commit-lost-delivery"), corrupt = Error("independent-native-corruption");
		f.hook((index, kind, ordinal) => {
			if (index === 0 && kind === "commit") throw lost;
			if (index === 0 && kind === "acquire" && ordinal === 3) throw corrupt;
		});
		const error = await applyClosedEpochRetirementIntent(f.input).catch(value => value);
		expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([lost, corrupt]);
		expect(f.effects).toEqual(["0:prepare", "0:commit"]); expect(f.phases[0]).toBe("completed");
		// Acquisition failed before a third view was returned; both actual views
		// joined, and no later participant or global completion was attempted.
		expect(f.released[0]).toBe(2); expect(f.acquired.slice(1)).toEqual([0, 0, 0, 0]);
		expect(f.coordinator.active).not.toBeNull(); expect(f.verified).toBe(0);
	});
	it("refuses a native pre-effect failure, joins its view and preserves the original error", async () => {
		const f = fixture();
		f.hook((index, kind) => {if (index === 0 && kind === "prepare") throw Error("before-effect");});
		await expect(applyClosedEpochRetirementIntent(f.input)).rejects.toThrow("before-effect");
		expect(f.effects).toEqual([]); expect(f.phases[0]).toBe("old");
		expect(f.acquired[0]).toBe(2); expect(f.released).toEqual(f.acquired);
	});
	it("rejects corrupt independent readback rather than trusting a successful mutation", async () => {
		const f = fixture();
		f.hook((index, kind, count) => {if (index === 0 && kind === "acquire" && count === 2) f.phases[0] = "old";});
		await expect(applyClosedEpochRetirementIntent(f.input)).rejects.toThrow("native outcome is not exact new state");
		expect(f.effects).toEqual(["0:prepare"]); expect(f.released).toEqual(f.acquired);
	});
	it("does not turn release failure on an already-completed skip into an attempted mutation", async () => {
		const f = fixture(); f.resumePrepared(); f.phases[0] = "completed";
		f.hook((index, kind) => {if (index === 0 && kind === "release") throw Error("skip-release");});
		await expect(applyClosedEpochRetirementIntent(f.input)).rejects.toThrow("skip-release");
		expect(f.acquired[0]).toBe(1); expect(f.released[0]).toBe(1); expect(f.effects).toEqual([]);
	});
	it("joins and refuses foreign commitment or malformed phase before effects", async () => {
		for (const change of ["commitment", "phase"] as const) {
			const f = fixture(), original = f.input.participants[0]!.acquire;
			f.input.participants[0]!.acquire = async () => {
				const read = await original();
				return change === "commitment" ? {...read, commitment: [...read.commitment.slice(0, 3), 1,
					...read.commitment.slice(4)] as unknown as AheRetirementDomain} : {...read, phase: "foreign" as never};
			};
			await expect(applyClosedEpochRetirementIntent(f.input)).rejects.toThrow(change === "commitment"
				? "native source image changed" : "native control malformed");
			expect(f.acquired[0]).toBe(1); expect(f.released[0]).toBe(1); expect(f.effects).toEqual([]);
		}
	});
});
