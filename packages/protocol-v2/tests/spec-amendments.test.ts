import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import registryDocument from "../registry/field-registry.json" with { type: "json" };

const specificationPath = new URL("../../../docs/protocol/attested-hard-epochs-v4.md", import.meta.url);
const amendmentLogPath = new URL("../../../docs/protocol/amendments-v2.json", import.meta.url);

interface RegistryField {
	const: unknown;
	constraints: Record<string, unknown>;
	name: string;
	sortRule: string | null;
}

interface RegistryKind {
	fields: RegistryField[];
}

interface AmendmentEntry {
	decision: number;
	id: string;
	normativeSource: string;
	registryPaths: string[];
	requirements: unknown;
	status: string;
}

interface AmendmentLog {
	amendmentLogVersion: string;
	effectiveDate: string;
	entries: AmendmentEntry[];
	normativeDocument: string;
	protocolMajor: number;
	registryVersion: number;
	status: string;
}

interface SpecMetadata {
	amendmentLog: string;
	protocolMajor: number;
	registryVersion: number;
	specVersion: string;
	status: string;
	title: string;
}

interface ContradictionDetector {
	allowed: string[];
	id: string;
	pattern: RegExp;
	rejected: string[];
}

const registry = registryDocument as unknown as {
	actions: string[];
	codec: {
		cbor: boolean;
		floatNegativeZero: { decode: string; encode: string };
		format: string;
		id: string;
	};
	domains: Record<string, string>;
	endianness: string;
	framing: {
		domainEncoding: string;
		domainLength: string;
		formula: string;
		magicHex: string;
		partLength: string;
	};
	kinds: Record<string, RegistryKind>;
	packageName: string;
	protocolMajor: number;
	quorum: {
		callerSuppliedMaxByzantine: boolean;
		f: string;
		q: string;
	};
	registryVersion: number;
	trustProfiles: string[];
};

const expectedEntryIds = Array.from({ length: 12 }, (_, index) => `PH-N1-D${String(index + 1).padStart(2, "0")}`);

const contradictionDetectors: ContradictionDetector[] = [
	{
		allowed: ["CBOR MUST NOT be used as the canonical consensus encoding."],
		id: "canonical-cbor",
		pattern:
			/(?:\bCBOR\b[^.\n]{0,48}\b(?:is|MUST\s+be|SHALL\s+be)\b[^.\n]{0,24}\bcanonical\b|\bcanonical(?: consensus)?(?: codec| encoding)?\b[^.\n]{0,32}\b(?:MUST|SHALL)\s+(?:be|use)\s+CBOR\b|\b(?:MUST|SHALL)\s+use\s+CBOR\b[^.\n]{0,32}\bcanonical\b)/iu,
		rejected: [
			"CBOR is the canonical consensus encoding.",
			"The canonical encoding MUST be CBOR.",
			"Implementations MUST use CBOR as the canonical codec.",
		],
	},
	{
		allowed: ["Typed arrays MUST use big-endian and MUST NOT use little-endian encoding."],
		id: "typed-array-little-endian",
		pattern:
			/\btyped[- ]arrays?\b[^.\n]{0,64}(?:(?:MUST|SHALL)\s+(?:use|be(?:\s+encoded)?)|are(?:\s+encoded)?)\s+little[- ]endian\b/iu,
		rejected: ["Typed-array values MUST use little-endian.", "Typed arrays MUST be little endian."],
	},
	{
		allowed: ["Signer sorting MUST NOT use locale-sensitive collation, Intl.Collator, or localeCompare."],
		id: "locale-sensitive-ordering",
		pattern:
			/\b(?:sort(?:ing|s)?|ordering|collation)\b[^.\n]{0,80}(?:(?:MUST|SHALL)\s+use|uses|via)\s+(?:locale-sensitive\s+collation|Intl\.Collator|localeCompare(?:\(\))?)/iu,
		rejected: [
			"Signer sorting MUST use locale-sensitive collation.",
			"Signer ordering MUST use Intl.Collator.",
			"Protocol sorting uses localeCompare().",
		],
	},
	{
		allowed: ["The conflict vocabulary has exactly five actions, including Drop."],
		id: "four-actions",
		pattern: /\b(?:exactly|only)\s+four\s+(?:conflict[- ]?)?actions\b/iu,
		rejected: ["The resolver has exactly four actions.", "Only four conflict actions are valid."],
	},
	{
		allowed: ["p256-sha256-v1 is reserved and MUST NOT be active."],
		id: "p256-active",
		pattern:
			/(?:\bp256-sha256-v1\b[^.\n]{0,40}\b(?:is|MUST\s+be|SHALL\s+be)\s+(?:an?\s+)?active\b|\bactive(?:\s+signature)?\s+suite\b[^.\n]{0,40}\bp256-sha256-v1\b)/iu,
		rejected: ["p256-sha256-v1 is an active suite.", "The active signature suite is p256-sha256-v1."],
	},
	{
		allowed: ["CutValue MUST NOT contain a round; SealProposal carries the round."],
		id: "round-bearing-cut-value",
		pattern:
			/\bCutValue\b[^.\n]{0,48}\bMUST\b(?!\s+NOT\b)[^.\n]{0,24}\b(?:have|contain|carry|include)\b[^.\n]{0,16}\b(?:a\s+)?round\b/iu,
		rejected: ["CutValue MUST have a round.", "CutValue MUST contain the round.", "CutValue MUST carry a round field."],
	},
	{
		allowed: ["A delegated browser-local voter without an external exact-slot witness MUST use fate-shared custody."],
		id: "unconditional-profile-fate-sharing",
		pattern:
			/\b(?:delegated|attested)\b(?![^.\n]{0,96}\bbrowser-local\b[^.\n]{0,96}\bMUST\b)[^.\n]{0,96}\bMUST\s+(?:be|use)\s+fate-shared\b/iu,
		rejected: [
			"Delegated key custody MUST be fate-shared-non-extractable.",
			"Delegated profiles MUST use fate-shared custody.",
			"Attested profile key custody MUST use fate-shared non-extractable keys.",
		],
	},
	{
		allowed: [
			"proposalDigest MUST equal SealProposal.valueDigest, the round-free CutValue digest.",
			"proposalHash MUST be the SealProposal digest; proposalDigest MUST remain round-free.",
		],
		id: "wrong-proposal-digest",
		pattern:
			/\bproposalDigest\b(?:(?![,.;]|\bproposalHash\b)[\s\S]){0,64}\bMUST\b(?!\s+NOT\b)(?:(?![,.;]|\bproposalHash\b)[\s\S]){0,128}(?:\bSealProposal\b(?!\.valueDigest)(?:(?![,.;]|\bproposalHash\b)[\s\S]){0,24}\bdigest\b|\bdigest\b(?:(?![,.;]|\bproposalHash\b)[\s\S]){0,24}\bof\b(?:(?![,.;]|\bproposalHash\b)[\s\S]){0,16}\bSealProposal\b(?!\.valueDigest))/iu,
		rejected: [
			"proposalDigest MUST be the SealProposal digest.",
			"proposalDigest MUST equal the digest of SealProposal.",
			`proposalDigest MUST be the round-bearing
SealProposal digest, while proposalHash and SealProposal.valueDigest
MUST be the round-free CutValue key.`,
		],
	},
	{
		allowed: [
			"Durable locks and committed-value comparison MUST use proposalDigest, the round-free value identity, and MUST never use proposalHash.",
			"Durable locks MUST use proposalDigest and MUST NOT use proposalHash.",
		],
		id: "wrong-lock-key",
		pattern:
			/\b(?:durable\s+locks?|committed[- ]value\s+comparison)\b(?:(?![.;])[\s\S]){0,96}\bMUST\s+(?!NOT\b|never\b)(?:use|(?:be\s+)?key(?:ed)?\s+(?:on|by))(?:(?![.;]|\bproposalDigest\b|\bMUST\b)[\s\S]){0,64}\bproposalHash\b/iu,
		rejected: [
			`Durable locks and committed-value comparison MUST use
proposalHash instead of proposalDigest.`,
			`Committed-value comparison MUST be keyed on
proposalHash, never proposalDigest.`,
		],
	},
	{
		allowed: [
			"A decoder MUST reject explicitly forbidden forms. Unsafe-integral Float64 acceptance and rejection remain unresolved.",
		],
		id: "unresolved-decoder-default",
		pattern:
			/\bdecoder\b[^.\n]{0,24}\bMUST\s+accept\s+(?:every|all)\b[^.\n]{0,48}\b(?:not\s+explicitly forbidden|other)\b/iu,
		rejected: ["A decoder MUST accept every wire form not explicitly forbidden."],
	},
];

const contradictionPatterns = contradictionDetectors.map(({ pattern }) => pattern);

const d05SafetyInversionSamples = [
	{
		id: "swapped-proposal-bindings",
		text: `proposalDigest MUST be the round-bearing
SealProposal digest, while proposalHash and SealProposal.valueDigest
MUST be the round-free CutValue key.`,
	},
	{
		id: "wrong-lock-key",
		text: `Durable locks and committed-value comparison MUST use
proposalHash instead of proposalDigest.`,
	},
];

const expectedRegistryPathsById: Record<string, string[]> = {
	"PH-N1-D01": ["framing"],
	"PH-N1-D02": ["endianness"],
	"PH-N1-D03": ["codec"],
	"PH-N1-D04": ["codec.floatNegativeZero"],
	"PH-N1-D05": [
		"kinds.cutValue.fields",
		"kinds.epochAnchor.fields",
		"kinds.snapshotPayload.fields",
		"kinds.sealProposal.fields",
		"kinds.sealVote.fields",
		"kinds.sealQC.fields",
	],
	"PH-N1-D06": ["kinds.sealVote.fields", "kinds.sealQC.fields", "kinds.roundChange.fields"],
	"PH-N1-D07": ["quorum"],
	"PH-N1-D08": ["kinds.signerSet.fields"],
	"PH-N1-D09": ["actions"],
	"PH-N1-D10": ["trustProfiles", "kinds.epochAnchor.fields", "kinds.profile.fields"],
	"PH-N1-D11": ["protocolMajor", "packageName", "domains"],
	"PH-N1-D12": ["kinds.epochAnchor.fields", "kinds.profile.fields"],
};

const expectedSectionConceptsById: Record<string, RegExp[]> = {
	"PH-N1-D01": [/DRP\\0|44525000/u, /\bU32BE\b/u, /\bU64BE\b/u, /\bdomain\b/iu, /\bpart\b/iu],
	"PH-N1-D02": [/\btyped[- ]array/iu, /\bbig[- ]endian\b/iu],
	"PH-N1-D03": [
		/\b(?:reference[- ]tag[- ]codec|tag codec)\b/iu,
		/(?:\bMUST NOT\b[^.\n]{0,40}\bCBOR\b|\bCBOR\b[^.\n]{0,40}\bMUST NOT\b)/iu,
		/\bdecoder/iu,
		/\bexplicitly forbidden\b/iu,
		/\bregistry[- ]v5\b/iu,
		/\bunsafe-integral\b/iu,
		/\bFloat64\b/u,
		/\bunresolved\b/iu,
		/\brejection requirement\b/iu,
		/\b(?:applies only|scoped to)\b/iu,
		/\b(?:those|enumerated) forms\b/iu,
	],
	"PH-N1-D04": [/(?:\bnegative zero\b|(?:^|[^\d])-0(?:$|[^\d]))/iu, /\bnormalize/iu, /\breject/iu, /\bFloat32Array\b/u],
	"PH-N1-D05": [
		/\barchiveIndexRoot\b/u,
		/\bavailabilityPolicyDigest\b/u,
		/\bblueprintDigest\b/u,
		/\bCutValue\b/u,
		/\bSealProposal\b/u,
		/\bvalueDigest\b/u,
		/\bproposalDigest\b/u,
		/\bproposalHash\b/u,
		/\block/iu,
		/\bround[- ]free\b/iu,
		/\bround[- ]bearing\b/iu,
	],
	"PH-N1-D06": [/\bhighestPrepareQC\b/u, /\bround-change\b/u, /\bprepare\b/iu, /\bcommit\b/iu],
	"PH-N1-D07": [
		/(?:ceil\s*\(\s*2\s*\*\s*n\s*\/\s*3\s*\)|⌈2n\/3⌉)/iu,
		/(?:floor\s*\(\s*\(\s*n\s*-\s*1\s*\)\s*\/\s*3\s*\)|⌊\(n−1\)\/3⌋)/iu,
		/\bmaxByzantine\b/u,
	],
	"PH-N1-D08": [/\bUTF-8\b/u, /\bbyte order\b/iu, /\bsignerId\b/u, /\bcontrol/iu],
	"PH-N1-D09": [
		/\bNop\b/u,
		/\bDropLeft\b/u,
		/\bDropRight\b/u,
		/\bSwap\b/u,
		/\bDrop\b/u,
		/\bboth\b/iu,
		/\bvertices\b/iu,
	],
	"PH-N1-D10": [
		/\bcreator-trusted-v1\b/u,
		/\bdelegated-trusted-v1\b/u,
		/\battested-bft-v1\b/u,
		/\bprofileDigest\b/u,
		/\bcryptoSuiteId\b/u,
		/\bgenesis\b/iu,
		/\banchor\b/iu,
		/\brecoverable\b/iu,
		/\bre-learn\b/iu,
		/\bfate-shared\b/iu,
		/\bnon-extractable\b/iu,
		/\bexact-slot\b/iu,
		/\banti-equivocation\b/iu,
		/\bdetectable-loss\b/iu,
		/\bdurable-class\b/iu,
		/\bincarnation\b/iu,
		/\brefus/iu,
		/\bCAS\b/u,
		/\boutbox\b/iu,
		/\bbrowser-local\b/iu,
		/\beviction-prone\b/iu,
		/\bexternal\b/iu,
		/\bwitness\b/iu,
		/\bstall\b/iu,
		/\bquorum reduction\b/iu,
	],
	"PH-N1-D11": [/\bprotocolMajor\b/u, /\b2\b/u, /\bts-drp\/.+\/v2\b/u, /\bprotocol-v2\b/u],
	"PH-N1-D12": [
		/\bed25519-sha256-v1\b/u,
		/\bed25519-seal-v1\b/u,
		/\bp256-sha256-v1\b/u,
		/\breserv/iu,
		/\blow-S\b/iu,
		/\braw\b/iu,
		/\bprehash/iu,
	],
};

const expectedRelatedConceptsById: Record<string, RegExp[][]> = {
	"PH-N1-D01": [
		[
			/\bdomain length\b[^.\n]{0,24}\bMUST\b[^.\n]{0,16}\bU32BE\b/iu,
			/\bevery part\b[^.\n]{0,24}\bMUST\b[^.\n]{0,24}\bU64BE\b[^.\n]{0,24}\bbyte length\b/iu,
		],
	],
	"PH-N1-D02": [[/\btyped-array payloads\b[^.\n]{0,32}\bMUST\b[^.\n]{0,16}\bbig-endian\b/iu]],
	"PH-N1-D03": [
		[/\bCBOR\b/u, /\bMUST NOT\b/u, /\bcanonical\b/iu],
		[
			/\bdecoder/iu,
			/\bMUST reject\b/u,
			/\bexplicitly forbidden\b/iu,
			/\bregistry[- ]v5\b/iu,
			/\bamendment/iu,
			/\brejection requirement\b/iu,
			/\b(?:applies only|scoped to)\b/iu,
			/\b(?:those|enumerated) forms\b/iu,
		],
		[/\bunsafe-integral\b/iu, /\bFloat64\b/u, /\bunresolved\b/iu, /\bMUST NOT\b/u, /\baccept/iu, /\breject/iu],
	],
	"PH-N1-D04": [
		[/\bencode/iu, /\bnormalize/iu],
		[/\bdecode/iu, /\breject/iu],
	],
	"PH-N1-D06": [
		[/\bhighestPrepareQC\b/u, /\bround-change\b/u],
		[/\bhighestPrepareQC\b/u, /\bMUST NOT\b/u, /\bprepare\b/iu, /\bcommit\b/iu, /\bvote preimages?\b/iu],
	],
	"PH-N1-D07": [[/\bmaxByzantine\b/u, /\bcaller[- ]supplied\b/iu, /\bMUST NOT\b/u]],
	"PH-N1-D05": [
		[/\bCutValue\b/u, /\bMUST NOT\b/u, /\bround\b/iu],
		[
			/\bproposalDigest\b[\s\S]{0,32}\bMUST\s+equal\b[\s\S]{0,32}\bSealProposal\.valueDigest\b/iu,
			/\bround-free\b[\s\S]{0,24}\bCutValue\b/iu,
		],
		[
			/\bproposalHash\b[\s\S]{0,32}\bMUST be\b[\s\S]{0,32}\bregistered digest\b[\s\S]{0,32}\bround-bearing\b[\s\S]{0,24}\bSealProposal\b/iu,
		],
		[
			/\bDurable locks\b/iu,
			/\bcommitted[- ]value comparison\b/iu,
			/\bMUST use\b[\s\S]{0,32}\bproposalDigest\b/iu,
			/\bMUST never use\b[\s\S]{0,64}\bproposalHash\b/iu,
		],
	],
	"PH-N1-D08": [
		[/\bMUST\b/u, /\bUTF-8 byte order\b/u, /\bsort/iu],
		[/\bMUST NOT\b/u, /\blocale-sensitive collation\b/iu],
	],
	"PH-N1-D09": [[/\bDrop\b/u, /\bboth\b/iu, /\bvertices\b/iu]],
	"PH-N1-D10": [
		[/\bbrowser-local\b/iu, /\beviction-prone\b/iu, /\bfate-shared\b/iu, /\bnon-extractable\b/iu],
		[/\bq\s*=\s*1\b/iu, /\bn\s*=\s*1\b/iu, /\bMUST NOT\b/u, /\bfate-share/iu],
		[/\bdetectable-loss\b/iu, /\bdurable-class\b/iu, /\bincarnation\b/iu, /\brefus/iu],
		[/\bexternal\b/iu, /\bexact-slot\b/iu, /\bwitness\b/iu, /\b(?:valid|allow)/iu],
		[/\bquorum\s*(?:>=|≥)\s*2\b/iu, /\bevery\b/iu, /\bvoter\b/iu, /\bexact-slot\b/iu, /\banti-equivocation\b/iu],
		[/\bdelegated\b/iu, /\battested\b/iu, /\b(?:admit|allow)/iu, /\bdurable-class\b/iu, /\bbrowser-local\b/iu],
		[/\beviction-prone\b/iu, /\bdurable-class\b/iu, /\bstall acceptance\b/iu],
		[/\bstall\b/iu, /\bMUST NOT\b/u, /\bquorum reduction\b/iu],
		[/\bdurable\b/iu, /\bCAS\b/u, /\boutbox\b/iu],
		[
			/\btrust profile\b/iu,
			/\bauthority\b/iu,
			/\bquorum\b/iu,
			/\bstorage class\b/iu,
			/\bcustody\b/iu,
			/\b(?:separat\w*|does not|MUST NOT)\b/iu,
		],
	],
	"PH-N1-D12": [
		[/\bp256-sha256-v1\b/u, /\breserv/iu],
		[/\breactivat/iu, /\bsame[- ](?:edit|amendment)\b/iu, /\blow-S\b/iu, /\b(?:digest mode|raw|prehash)/iu],
	],
	"PH-N1-D11": [
		[/\bprotocolMajor\b/u, /\b2\b/u, /\bdomains?\b/iu, /\/v2\b/u, /\bpackage\b/iu, /\bprotocol-v2\b/u, /\bMUST\b/u],
		[/\bAttested Hard Epochs v4\b/u, /\btitle\b/iu, /\bprotocol-major\b/iu, /\bMUST\b/u],
	],
};

function field(kind: string, name: string): RegistryField {
	const result = registry.kinds[kind]?.fields.find((candidate) => candidate.name === name);
	if (result === undefined) throw new TypeError(`registry field ${kind}.${name} is absent`);
	return result;
}

function fieldNames(kind: string): string[] {
	const definition = registry.kinds[kind];
	if (definition === undefined) throw new TypeError(`registry kind ${kind} is absent`);
	return definition.fields.map(({ name }) => name);
}

function requiredFieldMembership(kind: string, requiredNames: string[]): string[] {
	const names = fieldNames(kind);
	for (const requiredName of requiredNames) {
		if (!names.includes(requiredName)) throw new TypeError(`registry field ${kind}.${requiredName} is absent`);
	}
	return [...requiredNames];
}

function readAmendmentLog(): AmendmentLog | undefined {
	if (!existsSync(amendmentLogPath)) return undefined;
	return JSON.parse(readFileSync(amendmentLogPath, "utf8")) as AmendmentLog;
}

function readSpecification(): string {
	return existsSync(specificationPath) ? readFileSync(specificationPath, "utf8") : "";
}

function parseFrontMatter(source: string): SpecMetadata | undefined {
	const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(source);
	const body = match?.[1];
	if (body === undefined) return undefined;
	const values = Object.fromEntries(
		body.split("\n").map((line) => {
			const separator = line.indexOf(":");
			if (separator < 1) return [line, ""];
			const key = line.slice(0, separator).trim();
			const rawValue = line.slice(separator + 1).trim();
			const value = /^\d+$/u.test(rawValue) ? Number(rawValue) : rawValue;
			return [key, value];
		})
	);
	return values as unknown as SpecMetadata;
}

function resolveRegistryPath(path: string): unknown {
	return path.split(".").reduce<unknown>((current, segment) => {
		if (current === null || typeof current !== "object" || !(segment in current)) return undefined;
		return (current as Record<string, unknown>)[segment];
	}, registryDocument);
}

function expectedRequirementsById(): Record<string, unknown> {
	const cryptoSuiteConstraints = field("epochAnchor", "cryptoSuiteId").constraints;
	return {
		"PH-N1-D01": {
			domainEncoding: registry.framing.domainEncoding,
			domainLength: registry.framing.domainLength,
			formula: registry.framing.formula,
			magicHex: registry.framing.magicHex,
			partLength: registry.framing.partLength,
		},
		"PH-N1-D02": {
			framingIntegerEndianness: registry.endianness,
			typedArrayEndianness: registry.endianness,
		},
		"PH-N1-D03": {
			cbor: registry.codec.cbor,
			codecId: registry.codec.id,
			decoderRejectionScope: "only-registry-v5-or-amendment-explicitly-forbidden-forms",
			format: registry.codec.format,
			unsafeIntegralFloat64: "unresolved-neither-accept-nor-reject-ratified",
		},
		"PH-N1-D04": {
			decodeNegativeZero: registry.codec.floatNegativeZero.decode,
			encodeNegativeZero: registry.codec.floatNegativeZero.encode,
			includesFloat32Array: true,
		},
		"PH-N1-D05": {
			addedPreimageFields: {
				cutValue: ["archiveIndexRoot", "availabilityPolicyDigest"],
				epochAnchor: ["archiveIndexRoot", "blueprintDigest"],
				snapshotPayload: ["blueprintDigest", "archiveIndexRoot"],
			},
			cutValueFieldsExclude: fieldNames("cutValue").includes("round") ? [] : ["round"],
			sealProposalFieldsInclude: fieldNames("sealProposal").filter((name) => ["round", "valueDigest"].includes(name)),
			valueDigestPreimage: "CutValue",
			proposalHashPreimage: "SealProposal",
			voteProposalBindings: {
				lockAndCommitKey: "proposalDigest",
				proposalDigest: "round-free-cut-value-digest-equal-to-seal-proposal.valueDigest",
				proposalHash: "round-bearing-seal-proposal-digest",
				registeredFieldMembership: {
					sealQC: requiredFieldMembership("sealQC", ["proposalDigest", "proposalHash"]),
					sealVote: requiredFieldMembership("sealVote", ["proposalDigest", "proposalHash"]),
				},
			},
		},
		"PH-N1-D06": {
			highestPrepareQC: {
				roundChange: fieldNames("roundChange").includes("highestPrepareQC"),
				sealQC: fieldNames("sealQC").includes("highestPrepareQC"),
				sealVote: fieldNames("sealVote").includes("highestPrepareQC"),
			},
			roundChangePhase: field("roundChange", "phase").const,
		},
		"PH-N1-D07": registry.quorum,
		"PH-N1-D08": {
			protocolOrdering: "utf8-byte-order",
			registrySortRule: field("signerSet", "signers").sortRule,
			signerIdCharset: field("signerSet", "signers").constraints.signerIdCharset,
		},
		"PH-N1-D09": {
			actions: registry.actions,
			dropSemantics: "drop-both-vertices",
		},
		"PH-N1-D10": {
			policyAxes: {
				authorityAndQuorum: "trust-profile",
				custody: "voter-storage-class",
			},
			profileDigestAndCryptoSuiteIdSignedIn: ["genesis", "epochAnchor"],
			profiles: registry.trustProfiles,
			delegatedProfile: {
				minimumQuorum: 2,
				semantics: "k-of-n-not-bft",
			},
			voterStoragePolicy: {
				admittedStorageClassesByProfile: {
					"attested-bft-v1": ["detectable-loss-durable-class", "browser-local-eviction-prone"],
					"delegated-trusted-v1": ["detectable-loss-durable-class", "browser-local-eviction-prone"],
				},
				singleVoter: {
					custody: "recoverable-seed-derived-plus-network-relearn",
					fateSharedCustody: false,
					n: 1,
					q: 1,
				},
				quorumAtLeast2: {
					antiEquivocationContinuity: "exact-slot",
					externalExactSlotWitness: {
						continuity: "exact-slot",
						validMode: true,
					},
					minimumQuorum: 2,
					setComposition: {
						evictionProneSafeguard: "at-least-one-durable-class-voter-or-declared-stall-acceptance",
						stallTriggeredQuorumReduction: false,
					},
					storageClasses: {
						browserLocalEvictionProne: {
							custodyWithoutExternalExactSlotWitness: "fate-shared-non-extractable",
						},
						detectableLossDurableClass: {
							durableCasOutboxRequired: true,
							incarnationBinding: "required",
							onIncarnationMismatch: "refuse-permanently",
						},
					},
				},
			},
		},
		"PH-N1-D11": {
			domainPattern: "ts-drp/*/v2",
			packageName: registry.packageName,
			protocolMajor: registry.protocolMajor,
			specTitleException: "Attested Hard Epochs v4",
		},
		"PH-N1-D12": {
			activeSuiteCount: 2,
			activeSuiteIds: ["ed25519-sha256-v1", "ed25519-seal-v1"],
			activeSuites: {
				identityAndVertex: "ed25519-sha256-v1",
				sealVote: "ed25519-seal-v1",
			},
			ed25519Message: "raw-32-byte-registered-digest",
			p256Reactivation: {
				digestMode: "pin-raw-registered-digest-or-rehash",
				lowSNormalization: "pin",
				sameAmendment: true,
			},
			reservedSuites: cryptoSuiteConstraints.reservedValues,
		},
	};
}

describe("Phase -1g normative protocol amendments", () => {
	it("publishes one normative v2 specification and a versioned amendment log", () => {
		expect(existsSync(specificationPath), "missing docs/protocol/attested-hard-epochs-v4.md").toBe(true);
		expect(existsSync(amendmentLogPath), "missing docs/protocol/amendments-v2.json").toBe(true);

		const log = readAmendmentLog();
		expect(log).toBeDefined();
		if (log === undefined) return;
		expect(log).toMatchObject({
			amendmentLogVersion: "2.0.0",
			normativeDocument: "./attested-hard-epochs-v4.md",
			protocolMajor: registry.protocolMajor,
			registryVersion: registry.registryVersion,
			status: "normative",
		});
		expect(log.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);

		const metadata = parseFrontMatter(readSpecification());
		expect(metadata).toEqual({
			amendmentLog: "./amendments-v2.json",
			protocolMajor: registry.protocolMajor,
			registryVersion: registry.registryVersion,
			specVersion: "2.0.0",
			status: "normative",
			title: "Attested Hard Epochs v4",
		});
	});

	it("has one unique, exact, machine-readable semantic entry for every frozen decision", () => {
		const log = readAmendmentLog();
		expect(log).toBeDefined();
		if (log === undefined) return;

		const ids = log.entries.map(({ id }) => id);
		const decisions = log.entries.map(({ decision }) => decision);
		expect(ids).toEqual(expectedEntryIds);
		expect(new Set(ids).size).toBe(expectedEntryIds.length);
		expect(decisions).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
		expect(new Set(decisions).size).toBe(12);

		const expectedRequirements = expectedRequirementsById();
		for (const entry of log.entries) {
			expect(entry.status, entry.id).toBe("normative");
			expect(entry.registryPaths, entry.id).toEqual(expectedRegistryPathsById[entry.id]);
			for (const registryPath of entry.registryPaths) {
				expect(resolveRegistryPath(registryPath), `${entry.id}: unresolved registry path ${registryPath}`).not.toBe(
					undefined
				);
			}
			expect(entry.requirements, entry.id).toEqual(expectedRequirements[entry.id]);
		}
	});

	it("binds every decision to a real normative section and registry source", () => {
		const log = readAmendmentLog();
		const specification = readSpecification();
		expect(log).toBeDefined();
		expect(specification).not.toBe("");
		if (log === undefined || specification === "") return;

		expect(specification).toMatch(/^# Attested Hard Epochs v4$/mu);
		for (const entry of log.entries) {
			const anchor = `decision-${String(entry.decision).padStart(2, "0")}`;
			expect(entry.normativeSource, entry.id).toBe(`./attested-hard-epochs-v4.md#${anchor}`);

			const anchorOffset = specification.indexOf(`<a id="${anchor}"></a>`);
			expect(anchorOffset, `${entry.id}: missing normative anchor`).toBeGreaterThanOrEqual(0);
			if (anchorOffset < 0) continue;
			const nextAnchorOffset = specification.indexOf('<a id="decision-', anchorOffset + 1);
			const section = specification.slice(anchorOffset, nextAnchorOffset < 0 ? specification.length : nextAnchorOffset);
			expect(section, `${entry.id}: section is not normative`).toMatch(/\bMUST(?: NOT)?\b/u);
			expect(section, `${entry.id}: section is not cross-linked to its amendment`).toContain(entry.id);
			expect(section, `${entry.id}: section does not link the amendment log`).toContain("./amendments-v2.json");
			for (const concept of expectedSectionConceptsById[entry.id] ?? []) {
				expect(section, `${entry.id}: normative section omits ${String(concept)}`).toMatch(concept);
			}
			const boundedParagraphs = section
				.split(/\n\s*\n/u)
				.map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
				.filter((paragraph) => paragraph.length <= 1_200);
			for (const relatedConcepts of expectedRelatedConceptsById[entry.id] ?? []) {
				expect(
					boundedParagraphs.some((paragraph) => relatedConcepts.every((concept) => concept.test(paragraph))),
					`${entry.id}: related normative concepts are not stated together: ${relatedConcepts.join(", ")}`
				).toBe(true);
			}
		}
	});

	it("contains no affirmative legacy rule that contradicts the frozen semantics", () => {
		const log = readAmendmentLog();
		const corpus = `${readSpecification()}\n${log === undefined ? "" : JSON.stringify(log)}`;
		expect(corpus).not.toBe("\n");

		for (const detector of contradictionDetectors) {
			for (const sample of detector.rejected) {
				expect(sample, `${detector.id}: illegal sample escaped`).toMatch(detector.pattern);
			}
			for (const sample of detector.allowed) {
				expect(sample, `${detector.id}: scoped legal sample was rejected`).not.toMatch(detector.pattern);
			}
		}
		for (const sample of d05SafetyInversionSamples) {
			expect
				.soft(
					contradictionPatterns.some((pattern) => pattern.test(sample.text)),
					`${sample.id}: multiline D05 safety inversion escaped every contradiction detector`
				)
				.toBe(true);
		}
		for (const pattern of contradictionPatterns) expect(corpus).not.toMatch(pattern);
	});
});
