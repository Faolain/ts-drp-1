import { ed25519 } from "@noble/curves/ed25519.js";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import contract from "./fixtures/phase-5d-v3/pacemaker-law-contract.json" with { type: "json" };

interface RegistryField {
	readonly constraints?: Readonly<Record<string, unknown>>;
	readonly name: string;
	readonly type: string;
}

interface RegistryKind {
	readonly domain: string;
	readonly fields: readonly RegistryField[];
}

interface RegistryV1 {
	readonly kinds: Readonly<Record<string, RegistryKind>>;
	readonly protocolMajor: number;
	readonly registryVersion: number;
}

interface ReferenceResult {
	readonly canonicalHex: string;
	readonly digestHex: string;
	readonly id: string;
	readonly normalized: Readonly<Record<string, unknown>>;
}

interface WorkflowStep {
	readonly env?: Readonly<Record<string, unknown>>;
	readonly name?: string;
	readonly run?: string;
	readonly uses?: string;
	readonly with?: Readonly<Record<string, unknown>>;
}

interface WorkflowJob {
	readonly permissions?: Readonly<Record<string, unknown>>;
	readonly steps?: readonly WorkflowStep[];
}

interface WorkflowDocument {
	readonly jobs?: Readonly<Record<string, WorkflowJob>>;
	readonly on?: Readonly<Record<string, unknown>>;
	readonly permissions?: Readonly<Record<string, unknown>>;
}

interface PacemakerLaw {
	bundleCutValue: string;
	certificateQuorum: number;
	certificateSignerIds: string[];
	highestPrepareQCCustody: string;
	highestPrepareQCSelection: string;
	leaderOrdering: string;
	leaderRoster: string[];
	leaders: string[];
	maxFutureRoundGap: number;
	newRoundCertificate: string;
	proposalAuthentication: string;
	roundChangeDisposition: string;
	roundTimeoutBaseMs: number;
	firstCappedRound: number;
	roundTimeoutMaxMs: number;
	sealVotePhases: string[];
	timeouts: { round: number; timeoutMs: number }[];
}

interface CheckerResult {
	readonly output: string;
	readonly status: number | null;
}

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REFERENCE = resolve(REPOSITORY_ROOT, "packages/protocol-v3/conformance/original-reference/reference.mjs");
const REGISTRY_PATH = resolve(REPOSITORY_ROOT, "packages/protocol-v3/registry/registry-v1.json");
const SUPPLEMENT_ROOT = resolve(REPOSITORY_ROOT, contract.supplement.directory);
const CHECKER_ROOT_ENV = "PROTOCOL_V3_PACEMAKER_PROFILE_REPOSITORY_ROOT";
const DECISION_BLOCK_START = "<!-- PH-P5-D02:BEGIN -->";
const DECISION_BLOCK_END = "<!-- PH-P5-D02:END -->";
const SUPPLEMENT_READY = supplementReady();

function readJson<Value>(path: string): Value {
	return JSON.parse(readFileSync(path, "utf8")) as Value;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function bytesFromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError("fixture hex must be lowercase byte hex");
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function u32be(value: number): Uint8Array {
	const output = new Uint8Array(4);
	new DataView(output.buffer).setUint32(0, value, false);
	return output;
}

function u64be(value: number): Uint8Array {
	const output = new Uint8Array(8);
	new DataView(output.buffer).setBigUint64(0, BigInt(value), false);
	return output;
}

function independentDomainHash(domain: string, exactBytes: Uint8Array): string {
	const domainBytes = new TextEncoder().encode(domain);
	return createHash("sha256")
		.update(Uint8Array.of(0x44, 0x52, 0x50, 0x00))
		.update(u32be(domainBytes.byteLength))
		.update(domainBytes)
		.update(u64be(exactBytes.byteLength))
		.update(exactBytes)
		.digest("hex");
}

function encodeWithIndependentReference(
	cases: readonly { readonly id: string; readonly input: Readonly<Record<string, unknown>>; readonly kind: string }[]
): readonly ReferenceResult[] {
	const result = execFileSync(process.execPath, [REFERENCE], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		input: JSON.stringify({ cases, operation: "encode-corpus" }),
		maxBuffer: 16 * 1024 * 1024,
	});
	return (JSON.parse(result) as { readonly results: readonly ReferenceResult[] }).results;
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function governedTimeout(round: number, base: number, cap: number): number {
	if (!Number.isSafeInteger(round) || round < 0) throw new TypeError("invalid round");
	if (base <= 0 || cap < base) throw new TypeError("invalid timeout profile");
	const firstCappedRound = Math.ceil(Math.log2(cap / base));
	if (round >= firstCappedRound) return cap;
	return Math.min(cap, base * 2 ** round);
}

function semanticLawFromContract(): PacemakerLaw {
	return {
		bundleCutValue: contract.decision.requirements.bundleCutValue,
		certificateQuorum: contract.vectors.certificate.quorum,
		certificateSignerIds: [...contract.vectors.certificate.signerIds],
		highestPrepareQCCustody: contract.decision.requirements.highestPrepareQCCustody,
		highestPrepareQCSelection: contract.decision.requirements.highestPrepareQCSelection,
		leaderOrdering: contract.decision.requirements.leaderOrdering,
		leaderRoster: [...contract.vectors.leaderRoster],
		leaders: [...contract.vectors.leaders],
		maxFutureRoundGap: contract.decision.requirements.maxFutureRoundGap,
		newRoundCertificate: contract.decision.requirements.newRoundCertificate,
		proposalAuthentication: contract.decision.requirements.proposalAuthentication,
		roundChangeDisposition: contract.decision.requirements.roundChangeDisposition,
		roundTimeoutBaseMs: contract.decision.requirements.roundTimeoutBaseMs,
		firstCappedRound: contract.vectors.parameters.firstCappedRound,
		roundTimeoutMaxMs: contract.decision.requirements.roundTimeoutMaxMs,
		sealVotePhases: [...contract.decision.requirements.sealVotePhases],
		timeouts: structuredClone(contract.vectors.timeouts),
	};
}

function rejectMutant(id: keyof typeof contract.mutantRejections): never {
	throw new Error(contract.mutantRejections[id]);
}

function auditSemanticLaw(law: PacemakerLaw): void {
	if (law.roundTimeoutBaseMs !== 1000) rejectMutant("DIVERGENT_TIMEOUT_BASE");
	if (law.roundTimeoutMaxMs !== 30_000) rejectMutant("DIVERGENT_TIMEOUT_CAP");
	if (law.maxFutureRoundGap !== 8) rejectMutant("DIVERGENT_FUTURE_GAP");
	if (law.firstCappedRound !== 5) rejectMutant("UNCAPPED_EXPONENT");
	if (
		law.timeouts.some(
			({ round, timeoutMs }) => governedTimeout(round, law.roundTimeoutBaseMs, law.roundTimeoutMaxMs) !== timeoutMs
		)
	) {
		rejectMutant("UNCAPPED_EXPONENT");
	}
	const ordered = [...law.leaderRoster].sort(compareUtf8);
	if (law.leaderOrdering !== "raw-utf8-ascending" || ordered.join("\0") !== law.leaderRoster.join("\0")) {
		rejectMutant("LOCALE_SORTED_LEADER");
	}
	if (law.leaders.some((leader, round) => leader !== ordered[round % ordered.length])) {
		rejectMutant("LOCALE_SORTED_LEADER");
	}
	if (
		law.newRoundCertificate !== "exact-certified-quorum-no-truncation" ||
		law.certificateSignerIds.length !== law.certificateQuorum ||
		new Set(law.certificateSignerIds).size !== law.certificateQuorum ||
		[...law.certificateSignerIds].sort(compareUtf8).join("\0") !== law.certificateSignerIds.join("\0")
	) {
		rejectMutant("NEW_ROUND_CERTIFICATE_TRUNCATION");
	}
	if (law.bundleCutValue !== "exact-canonical-required") rejectMutant("PROPOSAL_WITHOUT_CUT_VALUE");
	if (law.proposalAuthentication !== "durable-leader-prepare-vote") rejectMutant("UNSIGNED_LEADER_PROPOSAL");
	if (law.highestPrepareQCCustody !== "complete-canonical-qc") rejectMutant("DIGEST_ONLY_HIGHEST_QC");
	if (law.highestPrepareQCSelection !== "greatest-round-then-lowest-registered-qc-digest") {
		rejectMutant("HIGHEST_QC_WRONG_TIE_BREAK");
	}
	if (
		law.roundChangeDisposition !== "distinct-registered-kind" ||
		JSON.stringify(law.sealVotePhases) !== JSON.stringify(["prepare", "commit"])
	) {
		rejectMutant("ROUND_CHANGE_AS_SEAL_VOTE_PHASE");
	}
}

function expectedProfileFromDecision(): Readonly<Record<string, unknown>> {
	const requirements = contract.decision.requirements;
	return {
		bundleCutValue: requirements.bundleCutValue,
		decisionId: contract.decision.id,
		highestPrepareQCCustody: requirements.highestPrepareQCCustody,
		highestPrepareQCSelection: requirements.highestPrepareQCSelection,
		leaderOrdering: requirements.leaderOrdering,
		maxFutureRoundGap: requirements.maxFutureRoundGap,
		newRoundCertificate: requirements.newRoundCertificate,
		profileId: contract.decision.profileId,
		proposalAuthentication: requirements.proposalAuthentication,
		protocolMajor: contract.decision.protocolMajor,
		registryVersion: contract.decision.registryVersion,
		roundChangeDisposition: requirements.roundChangeDisposition,
		roundTimeoutBaseMs: requirements.roundTimeoutBaseMs,
		roundTimeoutMaxMs: requirements.roundTimeoutMaxMs,
		sealVotePhases: requirements.sealVotePhases,
	};
}

function bytesToHex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function flipFirstByte(hex: string): string {
	const bytes = bytesFromHex(hex);
	bytes[0] = (bytes[0] ?? 0) ^ 1;
	return bytesToHex(bytes);
}

function fixtureSigner(signerId: string): (typeof contract.vectors.crypto.signers)[number] {
	const signer = contract.vectors.crypto.signers.find((candidate) => candidate.signerId === signerId);
	if (signer === undefined) throw new Error(`missing fixture signer ${signerId}`);
	return signer;
}

function selectHighestPrepareQC(
	qcs: readonly Readonly<{ digestHex: string; id: string; round: number; value: string }>[]
): Readonly<{ digestHex: string; id: string; round: number; value: string }> {
	if (qcs.length === 0) throw new Error("highest prepare QC candidates must be nonempty");
	const greatestRound = Math.max(...qcs.map(({ round }) => round));
	const greatest = qcs.filter(({ round }) => round === greatestRound);
	if (new Set(greatest.map(({ value }) => value)).size !== 1) rejectMutant("HIGHEST_QC_CONFLICT");
	return [...greatest].sort((left, right) =>
		left.digestHex.localeCompare(right.digestHex, "en-US")
	)[0] as (typeof qcs)[number];
}

function auditSelectedPrepareQC(
	qcs: readonly Readonly<{ digestHex: string; id: string; round: number; value: string }>[],
	selectedId: string
): void {
	const expected = selectHighestPrepareQC(qcs);
	const selected = qcs.find(({ id }) => id === selectedId);
	if (selected === undefined || selected.round < expected.round) rejectMutant("HIGHEST_QC_NOT_GREATEST_ROUND");
	if (selected.id !== expected.id) rejectMutant("HIGHEST_QC_WRONG_TIE_BREAK");
}

function auditCryptographicVectors(): readonly string[] {
	const crypto = contract.vectors.crypto;
	const cutCases = encodeWithIndependentReference([
		{ id: "cut-primary", input: crypto.cutValue, kind: "cutValue" },
		{
			id: "cut-alternate",
			input: { ...crypto.cutValue, stateDigest: "2a".repeat(32) },
			kind: "cutValue",
		},
	]);
	for (const result of cutCases) {
		expect(independentDomainHash("ts-drp/hard-epoch-cut/v3", bytesFromHex(result.canonicalHex))).toBe(result.digestHex);
	}
	expect(cutCases[0]?.digestHex).toBe(crypto.valueDigestHex);
	expect(cutCases[1]?.digestHex).toBe(crypto.alternateValueDigestHex);
	for (const signer of crypto.signers) {
		expect(bytesToHex(ed25519.getPublicKey(bytesFromHex(signer.privateKeySeedHex)))).toBe(signer.publicKeyHex);
	}

	const values = new Map([
		["primary", crypto.valueDigestHex],
		["alternate", crypto.alternateValueDigestHex],
	]);
	const proposalKeys = new Map<string, ReferenceResult>();
	const proposalCases = new Map<string, { id: string; input: Readonly<Record<string, unknown>>; kind: string }>();
	for (const qc of crypto.qcs) {
		const valueDigest = values.get(qc.value);
		if (valueDigest === undefined) throw new Error(`unknown value fixture ${qc.value}`);
		const id = `proposal:${qc.value}:${qc.round}`;
		proposalCases.set(id, {
			id,
			input: { epoch: 0, kind: "drp-seal-proposal", objectId: crypto.objectId, round: qc.round, valueDigest },
			kind: "sealProposal",
		});
	}
	proposalCases.set("proposal:primary:3", {
		id: "proposal:primary:3",
		input: {
			epoch: 0,
			kind: "drp-seal-proposal",
			objectId: crypto.objectId,
			round: crypto.proposal.round,
			valueDigest: crypto.valueDigestHex,
		},
		kind: "sealProposal",
	});
	for (const result of encodeWithIndependentReference([...proposalCases.values()])) {
		expect(independentDomainHash(contract.domains.sealProposal, bytesFromHex(result.canonicalHex))).toBe(
			result.digestHex
		);
		proposalKeys.set(result.id, result);
	}
	expect(proposalKeys.get("proposal:primary:3")?.digestHex).toBe(crypto.proposal.digestHex);

	const voteCases = new Map<string, { id: string; input: Readonly<Record<string, unknown>>; kind: string }>();
	for (const qc of crypto.qcs) {
		const valueDigest = values.get(qc.value);
		const proposalHash = proposalKeys.get(`proposal:${qc.value}:${qc.round}`)?.digestHex;
		if (valueDigest === undefined || proposalHash === undefined) throw new Error(`missing proposal for ${qc.id}`);
		for (const signerId of qc.signerIds) {
			const id = `vote:${qc.id}:${signerId}`;
			voteCases.set(id, {
				id,
				input: {
					epoch: 0,
					kind: "drp-seal-vote",
					objectId: crypto.objectId,
					phase: qc.phase,
					proposalDigest: valueDigest,
					proposalHash,
					round: qc.round,
					signerId,
				},
				kind: "sealVote",
			});
		}
	}
	for (const signerId of [crypto.leaderPrepareVote.signerId, "a"]) {
		const id = `vote:leader-r3:${signerId}`;
		voteCases.set(id, {
			id,
			input: {
				epoch: 0,
				kind: "drp-seal-vote",
				objectId: crypto.objectId,
				phase: "prepare",
				proposalDigest: crypto.valueDigestHex,
				proposalHash: crypto.proposal.digestHex,
				round: crypto.proposal.round,
				signerId,
			},
			kind: "sealVote",
		});
	}
	const votes = new Map(encodeWithIndependentReference([...voteCases.values()]).map((result) => [result.id, result]));
	for (const result of votes.values()) {
		expect(independentDomainHash(contract.domains.sealVote, bytesFromHex(result.canonicalHex))).toBe(result.digestHex);
	}
	const signedVote = (
		id: string,
		signerId: string
	): Readonly<{ signature: string; signerId: string; voteDigest: string }> => {
		const vote = votes.get(id);
		if (vote === undefined) throw new Error(`missing vote ${id}`);
		const signer = fixtureSigner(signerId);
		const signature = ed25519.sign(bytesFromHex(vote.digestHex), bytesFromHex(signer.privateKeySeedHex));
		expect(
			ed25519.verify(signature, bytesFromHex(vote.digestHex), bytesFromHex(signer.publicKeyHex), { zip215: false })
		).toBe(true);
		return { signature: bytesToHex(signature), signerId, voteDigest: vote.digestHex };
	};
	const leaderVote = signedVote(
		`vote:leader-r3:${crypto.leaderPrepareVote.signerId}`,
		crypto.leaderPrepareVote.signerId
	);
	expect(leaderVote).toEqual({
		signature: crypto.leaderPrepareVote.signatureHex,
		signerId: crypto.leaderPrepareVote.signerId,
		voteDigest: crypto.leaderPrepareVote.registeredDigestHex,
	});
	const expectedLeader = contract.vectors.leaders[crypto.proposal.round];
	expect(expectedLeader).toBe(crypto.leaderPrepareVote.signerId);
	if (signedVote("vote:leader-r3:a", "a").signerId !== expectedLeader) {
		expect(() => rejectMutant("PROPOSAL_WRONG_LEADER")).toThrowError(contract.mutantRejections.PROPOSAL_WRONG_LEADER);
	}

	const qcInputs = crypto.qcs.map((qc) => {
		const valueDigest = values.get(qc.value);
		const proposalHash = proposalKeys.get(`proposal:${qc.value}:${qc.round}`)?.digestHex;
		if (valueDigest === undefined || proposalHash === undefined) throw new Error(`missing QC proposal ${qc.id}`);
		return {
			id: qc.id,
			input: {
				epoch: 0,
				kind: "drp-seal-qc",
				objectId: crypto.objectId,
				phase: qc.phase,
				proposalDigest: valueDigest,
				proposalHash,
				round: qc.round,
				votes: qc.signerIds.map((signerId) => signedVote(`vote:${qc.id}:${signerId}`, signerId)),
			},
			kind: "sealQC",
		};
	});
	const qcs = new Map(encodeWithIndependentReference(qcInputs).map((result) => [result.id, result]));
	for (const result of qcs.values()) {
		expect(independentDomainHash(contract.domains.sealQC, bytesFromHex(result.canonicalHex))).toBe(result.digestHex);
	}
	for (const fixture of crypto.qcs) {
		expect(qcs.get(fixture.id)?.digestHex, fixture.id).toBe(fixture.digestHex);
	}

	const roundChangeInputs = crypto.roundChanges.map((row) => ({
		id: row.id,
		input: {
			anchor: crypto.anchor,
			epoch: 0,
			highestPrepareQC: row.highestPrepareQC === null ? null : qcs.get(row.highestPrepareQC)?.normalized,
			kind: "drp-round-change",
			objectId: "objectId" in row ? row.objectId : crypto.objectId,
			phase: "round-change",
			round: contract.vectors.certificate.round,
			signerId: row.signerId,
		},
		kind: "roundChange",
	}));
	const roundChanges = new Map(encodeWithIndependentReference(roundChangeInputs).map((result) => [result.id, result]));
	for (const result of roundChanges.values()) {
		expect(independentDomainHash(contract.domains.roundChange, bytesFromHex(result.canonicalHex))).toBe(
			result.digestHex
		);
	}
	for (const row of crypto.roundChanges) {
		const result = roundChanges.get(row.id);
		if (result === undefined) throw new Error(`missing round change ${row.id}`);
		expect(result.digestHex, row.id).toBe(row.digestHex);
		const signer = fixtureSigner(row.signerId);
		expect(
			ed25519.verify(
				bytesFromHex(row.signatureHex),
				bytesFromHex(result.digestHex),
				bytesFromHex(signer.publicKeyHex),
				{
					zip215: false,
				}
			)
		).toBe(true);
	}

	const auditCertificate = (ids: readonly string[], signatureOverride?: Readonly<Record<string, string>>): void => {
		if (ids.length !== contract.vectors.certificate.quorum) {
			rejectMutant(
				ids.length < contract.vectors.certificate.quorum
					? "NEW_ROUND_CERTIFICATE_TRUNCATION"
					: "NEW_ROUND_CERTIFICATE_OVER_QUORUM"
			);
		}
		const seen = new Set<string>();
		for (const id of ids) {
			const fixture = crypto.roundChanges.find((row) => row.id === id);
			const result = roundChanges.get(id);
			if (fixture === undefined || result === undefined) throw new Error(`missing certificate member ${id}`);
			if (
				result.normalized.objectId !== crypto.objectId ||
				result.normalized.epoch !== 0 ||
				result.normalized.anchor !== crypto.anchor ||
				result.normalized.round !== contract.vectors.certificate.round
			) {
				rejectMutant("WRONG_TUPLE_ROUND_CHANGE");
			}
			if (!contract.vectors.leaderRoster.includes(fixture.signerId) || seen.has(fixture.signerId)) {
				rejectMutant("NONMEMBER_ROUND_CHANGE");
			}
			seen.add(fixture.signerId);
			const signer = fixtureSigner(fixture.signerId);
			const signature = signatureOverride?.[id] ?? fixture.signatureHex;
			if (
				!ed25519.verify(bytesFromHex(signature), bytesFromHex(result.digestHex), bytesFromHex(signer.publicKeyHex), {
					zip215: false,
				})
			) {
				rejectMutant("INVALID_REGISTERED_SIGNATURE");
			}
		}
	};
	expect(
		contract.vectors.certificate.roundChangeIds.map((id) => crypto.roundChanges.find((row) => row.id === id)?.signerId)
	).toEqual(contract.vectors.certificate.signerIds);
	auditCertificate(contract.vectors.certificate.roundChangeIds);
	expect(() => auditCertificate(contract.vectors.certificate.roundChangeIds.slice(0, -1))).toThrowError(
		contract.mutantRejections.NEW_ROUND_CERTIFICATE_TRUNCATION
	);
	expect(() => auditCertificate([...contract.vectors.certificate.roundChangeIds, "round-change-null-a"])).toThrowError(
		contract.mutantRejections.NEW_ROUND_CERTIFICATE_OVER_QUORUM
	);
	expect(() => auditCertificate(["round-change-null-a", "round-change-qc2a-z", "round-change-nonmember"])).toThrowError(
		contract.mutantRejections.NONMEMBER_ROUND_CHANGE
	);
	expect(() =>
		auditCertificate(["round-change-wrong-tuple", "round-change-qc2a-z", "round-change-qc2b-private"])
	).toThrowError(contract.mutantRejections.WRONG_TUPLE_ROUND_CHANGE);
	expect(() =>
		auditCertificate(contract.vectors.certificate.roundChangeIds, {
			"round-change-null-a": flipFirstByte(crypto.roundChanges[0].signatureHex),
		})
	).toThrowError(contract.mutantRejections.INVALID_REGISTERED_SIGNATURE);

	const qcFixtures = new Map(crypto.qcs.map((qc) => [qc.id, qc]));
	const selectedCandidates = crypto.selection.candidates
		.map((id) => qcFixtures.get(id))
		.filter((qc) => qc !== undefined);
	expect(selectHighestPrepareQC(selectedCandidates).id).toBe(crypto.selection.expected);
	expect(() => auditSelectedPrepareQC(selectedCandidates, "prepare-r1")).toThrowError(
		contract.mutantRejections.HIGHEST_QC_WRONG_TIE_BREAK
	);
	expect(() => auditSelectedPrepareQC(selectedCandidates, "prepare-r2-b")).toThrowError(
		contract.mutantRejections.HIGHEST_QC_WRONG_TIE_BREAK
	);
	const conflictingCandidates = crypto.selection.conflictingCandidates
		.map((id) => qcFixtures.get(id))
		.filter((qc) => qc !== undefined);
	expect(() => selectHighestPrepareQC(conflictingCandidates)).toThrowError(
		contract.mutantRejections.HIGHEST_QC_CONFLICT
	);
	return [
		"HIGHEST_QC_CONFLICT",
		"HIGHEST_QC_NOT_GREATEST_ROUND",
		"HIGHEST_QC_WRONG_TIE_BREAK",
		"INVALID_REGISTERED_SIGNATURE",
		"NEW_ROUND_CERTIFICATE_OVER_QUORUM",
		"NONMEMBER_ROUND_CHANGE",
		"PROPOSAL_WRONG_LEADER",
		"WRONG_TUPLE_ROUND_CHANGE",
	];
}

function supplementReady(): boolean {
	if (!existsSync(SUPPLEMENT_ROOT) || !statSync(SUPPLEMENT_ROOT).isDirectory()) return false;
	if (
		JSON.stringify(readdirSync(SUPPLEMENT_ROOT).sort()) !== JSON.stringify([...contract.supplement.exactFiles].sort())
	) {
		return false;
	}
	const required = [
		...contract.supplement.exactFiles.map((file) => resolve(SUPPLEMENT_ROOT, file)),
		resolve(REPOSITORY_ROOT, contract.supplement.workflow),
	];
	if (!required.every((path) => existsSync(path) && statSync(path).isFile())) return false;
	const checker = spawnSync(process.execPath, [resolve(REPOSITORY_ROOT, contract.supplement.checker)], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		timeout: 30_000,
	});
	return checker.status === 0;
}

function parseNormativeDecision(specification: string): unknown {
	if (
		specification.split(DECISION_BLOCK_START).length - 1 !== 1 ||
		specification.split(DECISION_BLOCK_END).length - 1 !== 1
	) {
		throw new Error("NORMATIVE_DECISION_BLOCK_COUNT");
	}
	const start = specification.indexOf(DECISION_BLOCK_START) + DECISION_BLOCK_START.length;
	const end = specification.indexOf(DECISION_BLOCK_END, start);
	const match = /^```json\n(?<json>[\s\S]+)\n```$/u.exec(specification.slice(start, end).trim());
	if (match?.groups?.json === undefined) throw new Error("NORMATIVE_DECISION_BLOCK_FORMAT");
	return JSON.parse(match.groups.json) as unknown;
}

function normalizedShellLines(source: string): readonly string[] {
	return source
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function expectedFreezeShellLines(): readonly string[] {
	return [
		'if git cat-file -e "$BASE_SHA:$CHECKER"; then',
		'git show "$BASE_SHA:$CHECKER" > "$RUNNER_TEMP/check-pacemaker-profile-base.mjs"',
		`${CHECKER_ROOT_ENV}="$GITHUB_WORKSPACE" \\`,
		'node "$RUNNER_TEMP/check-pacemaker-profile-base.mjs" "$BASE_SHA"',
		'elif ! git cat-file -e "$BASE_SHA:$POLICY" \\',
		'&& ! git cat-file -e "$BASE_SHA:$PROFILE" \\',
		'&& ! git cat-file -e "$BASE_SHA:$SCHEMA" \\',
		'&& ! git cat-file -e "$BASE_SHA:$SPECIFICATION" \\',
		'&& ! git cat-file -e "$BASE_SHA:$VECTORS" \\',
		'&& ! git cat-file -e "$BASE_SHA:$WORKFLOW" \\',
		'&& ! git cat-file -e "$BASE_SHA:$RED_TEST" \\',
		'&& ! git cat-file -e "$BASE_SHA:$RED_CONTRACT"; then',
		`${CHECKER_ROOT_ENV}="$GITHUB_WORKSPACE" node "$CHECKER" "$BASE_SHA"`,
		"else",
		'echo "Pacemaker profile bootstrap is fail-closed and atomic." >&2',
		"exit 1",
		"fi",
		`${CHECKER_ROOT_ENV}="$GITHUB_WORKSPACE" node "$CHECKER" "$BASE_SHA"`,
	];
}

function auditWorkflow(source: string): void {
	const document = parse(source) as WorkflowDocument;
	expect(Object.keys(document.on ?? {})).toEqual([contract.workflowContract.trigger]);
	expect(document.permissions).toEqual(contract.workflowContract.permissions);
	const jobs = Object.values(document.jobs ?? {});
	expect(jobs).toHaveLength(1);
	const job = jobs[0];
	expect(job?.permissions === undefined || job.permissions).toEqual(
		job?.permissions === undefined ? undefined : contract.workflowContract.permissions
	);
	const steps = job?.steps ?? [];
	const checkout = steps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
	expect(checkout?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/u);
	expect(checkout?.with).toEqual({
		"fetch-depth": contract.workflowContract.fetchDepth,
		"ref": contract.workflowContract.checkoutRef,
	});
	const node = steps.find(({ uses }) => uses?.startsWith("actions/setup-node@"));
	expect(node?.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/u);
	expect(node?.with).toEqual({ "node-version": contract.workflowContract.nodeVersion });
	const pnpm = steps.find(({ uses }) => uses?.startsWith("pnpm/action-setup@"));
	expect(pnpm?.uses).toMatch(/^pnpm\/action-setup@[0-9a-f]{40}$/u);
	expect(pnpm?.with).toEqual({ version: contract.workflowContract.pnpmVersion });
	const install = steps.find(({ run }) => run?.trim() === contract.workflowContract.installCommand);
	const java = steps.find(({ uses }) => uses?.startsWith("actions/setup-java@"));
	expect(java?.uses).toMatch(/^actions\/setup-java@[0-9a-f]{40}$/u);
	expect(java?.with).toEqual({
		"distribution": contract.workflowContract.javaDistribution,
		"java-version": contract.workflowContract.javaVersion,
	});
	const freeze = steps.find(({ env }) => env?.CHECKER === contract.supplement.checker);
	expect(freeze?.env?.BASE_SHA).toBe(contract.workflowContract.baseSha);
	expect(normalizedShellLines(freeze?.run ?? "")).toEqual(expectedFreezeShellLines());
	const formal = steps.find(({ env }) => env?.FORMAL_MODEL === contract.workflowContract.formalModel);
	expect(formal?.env).toMatchObject({ APALACHE_VERSION: contract.workflowContract.apalacheVersion });
	expect(normalizedShellLines(formal?.run ?? "")).toEqual([
		'if [ -f "$FORMAL_MODEL" ]; then',
		"pnpm run phase5d:formal",
		"else",
		'echo "Phase 5d formal model is not present yet; formal success is not claimed."',
		"fi",
	]);
	const ordered = [checkout, node, pnpm, install, java, freeze, formal].map((step) =>
		steps.indexOf(step as WorkflowStep)
	);
	expect(ordered.every((index) => index >= 0)).toBe(true);
	expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
	expect(source).not.toMatch(/pull_request_target|continue-on-error|write-all|contents:\s*write/u);
}

function git(root: string, ...args: readonly string[]): ReturnType<typeof spawnSync> {
	return spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
}

function copyFileIntoControlledRepository(root: string, path: string): void {
	const target = resolve(root, path);
	mkdirSync(dirname(target), { recursive: true });
	cpSync(resolve(REPOSITORY_ROOT, path), target);
}

function initializeControlledRepository(root: string): void {
	expect(git(root, "init", "-q").status).toBe(0);
	expect(git(root, "config", "user.email", "phase5d@example.invalid").status).toBe(0);
	expect(git(root, "config", "user.name", "phase5d-freeze-control").status).toBe(0);
	expect(git(root, "config", "commit.gpgsign", "false").status).toBe(0);
}

function commitControlledRepository(root: string, message: string): string {
	expect(git(root, "add", ".").status).toBe(0);
	const committed = git(root, "commit", "-q", "-m", message);
	if (committed.status !== 0) throw new Error(`${committed.stdout}\n${committed.stderr}`);
	return String(git(root, "rev-parse", "HEAD").stdout).trim();
}

function copyBaseTuple(root: string): void {
	for (const path of Object.keys(contract.baseTupleSha256)) copyFileIntoControlledRepository(root, path);
}

function copyGovernedOwner(root: string): void {
	for (const path of contract.supplement.protectedArtifacts) copyFileIntoControlledRepository(root, path);
}

function prepareCheckerDependencies(root: string): void {
	copyFileIntoControlledRepository(root, "package.json");
	const modules = resolve(root, "node_modules");
	if (!existsSync(modules)) symlinkSync(resolve(REPOSITORY_ROOT, "node_modules"), modules, "dir");
}

function executeChecker(root: string, base: string, checker = contract.supplement.checker): CheckerResult {
	const result = spawnSync(process.execPath, [resolve(root, checker), base], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, [CHECKER_ROOT_ENV]: root },
		timeout: 30_000,
	});
	return { output: `${result.stdout}\n${result.stderr}`, status: result.status };
}

function executeBaseThenCurrentChecker(root: string, base: string): CheckerResult {
	const baseSource = git(root, "show", `${base}:${contract.supplement.checker}`);
	if (baseSource.status !== 0) return executeChecker(root, base);
	const trusted = resolve(root, ".phase5d-base-checker.mjs");
	writeFileSync(trusted, baseSource.stdout);
	const baseResult = executeChecker(root, base, ".phase5d-base-checker.mjs");
	if (baseResult.status !== 0) return baseResult;
	return executeChecker(root, base);
}

function withControlledRepository(
	baseKind: "absent" | "complete" | "partial",
	action: (input: Readonly<{ base: string; root: string }>) => void
): void {
	const root = mkdtempSync(join(tmpdir(), "ts-drp-phase5d-pacemaker-law-"));
	try {
		initializeControlledRepository(root);
		copyBaseTuple(root);
		if (baseKind === "complete") copyGovernedOwner(root);
		if (baseKind === "partial") {
			const partialOwner = contract.supplement.protectedArtifacts.at(-1);
			if (partialOwner === undefined) throw new Error("protected owner roster must be nonempty");
			copyFileIntoControlledRepository(root, partialOwner);
		}
		const base = commitControlledRepository(root, "base");
		if (baseKind !== "complete") copyGovernedOwner(root);
		prepareCheckerDependencies(root);
		action({ base, root });
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}

describe("D.106a governed protocol-v3 pacemaker profile RED", () => {
	it("keeps the inherited v3 tuple byte-identical and proves the composition law independently", () => {
		expect(
			Object.fromEntries(
				Object.keys(contract.baseTupleSha256).map((path) => [path, sha256File(resolve(REPOSITORY_ROOT, path))])
			)
		).toEqual(contract.baseTupleSha256);

		const registry = readJson<RegistryV1>(REGISTRY_PATH);
		expect({ protocolMajor: registry.protocolMajor, registryVersion: registry.registryVersion }).toEqual({
			protocolMajor: contract.decision.protocolMajor,
			registryVersion: contract.decision.registryVersion,
		});
		expect(registry.kinds.sealProposal?.domain).toBe(contract.domains.sealProposal);
		expect(registry.kinds.sealProposal?.fields.map(({ name }) => name)).toEqual([
			"kind",
			"objectId",
			"epoch",
			"round",
			"valueDigest",
		]);
		expect(registry.kinds.sealVote?.domain).toBe(contract.domains.sealVote);
		expect(registry.kinds.sealVote?.fields.find(({ name }) => name === "phase")).toMatchObject({
			constraints: { values: ["prepare", "commit"] },
			type: "enum",
		});
		expect(registry.kinds.sealQC?.domain).toBe(contract.domains.sealQC);
		expect(registry.kinds.roundChange?.domain).toBe(contract.domains.roundChange);
		expect(registry.kinds.roundChange?.fields.map(({ name }) => name)).toEqual([
			"kind",
			"objectId",
			"epoch",
			"anchor",
			"round",
			"phase",
			"highestPrepareQC",
			"signerId",
		]);
		expect(registry.kinds.roundChange?.fields.find(({ name }) => name === "highestPrepareQC")?.type).toBe(
			"seal-qc|null"
		);

		expect(registry.kinds.cutValue?.fields.map(({ name }) => name).sort()).toEqual(
			Object.keys(contract.vectors.crypto.cutValue).sort()
		);
		expect(contract.profile).toEqual(expectedProfileFromDecision());
		expect(contract.vectors.parameters).toEqual({
			firstCappedRound: 5,
			maxFutureRoundGap: contract.decision.requirements.maxFutureRoundGap,
			roundTimeoutBaseMs: contract.decision.requirements.roundTimeoutBaseMs,
			roundTimeoutMaxMs: contract.decision.requirements.roundTimeoutMaxMs,
		});
		const cryptographicMutants = auditCryptographicVectors();

		const law = semanticLawFromContract();
		expect(() => auditSemanticLaw(law)).not.toThrow();
		const mutants = [
			[
				"DIVERGENT_TIMEOUT_BASE",
				(value: PacemakerLaw): void => {
					value.roundTimeoutBaseMs = 999;
				},
			],
			[
				"DIVERGENT_TIMEOUT_CAP",
				(value: PacemakerLaw): void => {
					value.roundTimeoutMaxMs = 29_999;
				},
			],
			[
				"DIVERGENT_FUTURE_GAP",
				(value: PacemakerLaw): void => {
					value.maxFutureRoundGap = 9;
				},
			],
			[
				"UNCAPPED_EXPONENT",
				(value: PacemakerLaw): void => {
					const timeout = value.timeouts.at(-1);
					if (timeout === undefined) throw new Error("timeout vectors must be nonempty");
					timeout.timeoutMs = Number.POSITIVE_INFINITY;
				},
			],
			[
				"LOCALE_SORTED_LEADER",
				(value: PacemakerLaw): void => {
					value.leaders = ["a", "z", "𐀀", "", "a", "z", "𐀀", ""];
				},
			],
			[
				"NEW_ROUND_CERTIFICATE_TRUNCATION",
				(value: PacemakerLaw): void => {
					value.certificateSignerIds.push("signer:d");
				},
			],
			[
				"PROPOSAL_WITHOUT_CUT_VALUE",
				(value: PacemakerLaw): void => {
					value.bundleCutValue = "digest-only";
				},
			],
			[
				"UNSIGNED_LEADER_PROPOSAL",
				(value: PacemakerLaw): void => {
					value.proposalAuthentication = "unsigned";
				},
			],
			[
				"DIGEST_ONLY_HIGHEST_QC",
				(value: PacemakerLaw): void => {
					value.highestPrepareQCCustody = "digest-only";
				},
			],
			[
				"ROUND_CHANGE_AS_SEAL_VOTE_PHASE",
				(value: PacemakerLaw): void => {
					value.sealVotePhases.push("round-change");
				},
			],
		] as const;
		for (const [id, mutate] of mutants) {
			const candidate = structuredClone(law);
			mutate(candidate);
			expect(() => auditSemanticLaw(candidate), id).toThrowError(
				contract.mutantRejections[id as keyof typeof contract.mutantRejections]
			);
		}
		expect(
			[
				...mutants.map(([id]) => id),
				...cryptographicMutants,
				"BASE_V3_TUPLE_EDIT",
				"CHECKER_WITHOUT_BASE_BOOTSTRAP",
				"UNPROTECTED_RED_OWNER",
			].sort()
		).toEqual(Object.keys(contract.mutantRejections).sort());
	});

	it("has the complete checker-authenticated seven-file PH-P5-D02 owner", () => {
		expect(SUPPLEMENT_READY).toBe(true);
	});
});

describe.skipIf(!SUPPLEMENT_READY)("D.106a frozen supplement behavior", () => {
	it("binds the exact profile, vectors, normative decision, and workflow", () => {
		expect(readJson(resolve(SUPPLEMENT_ROOT, "profile.json"))).toEqual(contract.profile);
		expect(readJson(resolve(SUPPLEMENT_ROOT, "vectors.json"))).toEqual(contract.vectors);
		expect(parseNormativeDecision(readFileSync(resolve(SUPPLEMENT_ROOT, "spec.md"), "utf8"))).toEqual(
			contract.decision
		);
		auditWorkflow(readFileSync(resolve(REPOSITORY_ROOT, contract.supplement.workflow), "utf8"));
	});

	it("pins the closed schema, protected owners, checker, and single-use bootstrap", () => {
		const schema = readJson<Record<string, unknown>>(resolve(SUPPLEMENT_ROOT, "schema.json"));
		const policy = readJson<{
			readonly artifactSha256: Readonly<Record<string, string>>;
			readonly checker: string;
			readonly checkerSha256: string;
			readonly profile: string;
			readonly protectedArtifacts: readonly string[];
			readonly schemaVersion: string;
			readonly workflow: string;
		}>(resolve(SUPPLEMENT_ROOT, "freeze-policy.json"));
		expect(schema).toMatchObject({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" });
		expect(policy).toMatchObject({
			checker: "check-freeze.mjs",
			profile: contract.decision.profileId,
			protectedArtifacts: contract.supplement.protectedArtifacts,
			schemaVersion: "ts-drp-pacemaker-profile-freeze-v1",
			workflow: contract.supplement.workflow,
		});
		expect(policy.checkerSha256).toBe(sha256File(resolve(SUPPLEMENT_ROOT, "check-freeze.mjs")));
		for (const [path, digest] of Object.entries(policy.artifactSha256)) {
			expect(digest).toBe(sha256File(resolve(REPOSITORY_ROOT, path)));
		}
		expect(Object.keys(policy.artifactSha256).sort()).toEqual(
			contract.supplement.protectedArtifacts
				.filter((path) => !path.endsWith("check-freeze.mjs") && !path.endsWith("freeze-policy.json"))
				.sort()
		);

		withControlledRepository("absent", ({ base, root }) => {
			const result = executeChecker(root, base);
			expect(result.status, result.output).toBe(0);
		});
		withControlledRepository("complete", ({ base, root }) => {
			const result = executeBaseThenCurrentChecker(root, base);
			expect(result.status, result.output).toBe(0);
			const path = Object.keys(contract.baseTupleSha256)[0];
			if (path === undefined) throw new Error("base tuple must be nonempty");
			writeFileSync(resolve(root, path), `${readFileSync(resolve(root, path), "utf8")}\n`);
			const drift = executeBaseThenCurrentChecker(root, base);
			expect(drift.status).not.toBe(0);
			expect(drift.output).toContain(contract.mutantRejections.BASE_V3_TUPLE_EDIT);
		});
		withControlledRepository("complete", ({ base, root }) => {
			const policyPath = resolve(root, contract.supplement.directory, "freeze-policy.json");
			const candidate = readJson<{ artifactSha256: Record<string, string>; protectedArtifacts: string[] }>(policyPath);
			const redOwner = "tests/phase-5d-pacemaker-law-red.test.ts";
			candidate.protectedArtifacts = candidate.protectedArtifacts.filter((path) => path !== redOwner);
			delete candidate.artifactSha256[redOwner];
			writeFileSync(policyPath, `${JSON.stringify(candidate, null, "\t")}\n`);
			const result = executeBaseThenCurrentChecker(root, base);
			expect(result.status).not.toBe(0);
			expect(result.output).toContain(contract.mutantRejections.UNPROTECTED_RED_OWNER);
		});
		withControlledRepository("partial", ({ base, root }) => {
			const result = executeChecker(root, base);
			expect(result.status).not.toBe(0);
			expect(result.output).toContain(contract.mutantRejections.CHECKER_WITHOUT_BASE_BOOTSTRAP);
		});
		withControlledRepository("complete", ({ base, root }) => {
			writeFileSync(resolve(root, contract.supplement.checker), "process.exit(0);\n");
			const result = executeBaseThenCurrentChecker(root, base);
			expect(result.status).not.toBe(0);
			expect(result.output).toContain(contract.mutantRejections.CHECKER_WITHOUT_BASE_BOOTSTRAP);
		});
	});

	it("passes the real supplement checker", () => {
		expect(() =>
			execFileSync(process.execPath, [resolve(REPOSITORY_ROOT, contract.supplement.checker)], {
				cwd: REPOSITORY_ROOT,
				stdio: "pipe",
				timeout: 30_000,
			})
		).not.toThrow();
	});
});
