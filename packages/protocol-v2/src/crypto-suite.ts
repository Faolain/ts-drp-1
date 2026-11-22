import { DRPError } from "@ts-drp/errors";

import { protocolRegistry, type RegistryDocument, type RegistryField } from "./registry.js";

/** Suite identifiers available for genesis negotiation. */
export type ActiveCryptoSuiteId = "ed25519-seal-v1" | "ed25519-sha256-v1";

/** Suite identifiers recognized by the registry but not yet negotiable. */
export type ReservedCryptoSuiteId = "p256-sha256-v1";

/** Every suite identifier recognized by the Phase -1 registry. */
export type CryptoSuiteId = ActiveCryptoSuiteId | ReservedCryptoSuiteId;

/** Registry classification attached to unsupported-profile failures. */
export type CryptoSuiteStatus = "active" | "reserved" | "unknown" | "unsupported-by-peer";

/** Genesis-only capability negotiation input. */
export interface GenesisCryptoSuiteNegotiation {
	namedSuiteId: string;
	peerSuiteIds: readonly string[];
}

/** Fail-closed protocol error for an unavailable genesis crypto profile. */
export class UnsupportedProfileError extends DRPError {
	/**
	 * @param suiteId - Requested suite identifier.
	 * @param suiteStatus - Registry or peer-support classification.
	 */
	constructor(
		readonly suiteId: string,
		readonly suiteStatus: CryptoSuiteStatus
	) {
		super("UNSUPPORTED_PROFILE", `crypto suite ${suiteId} is ${suiteStatus}`);
		this.name = "UnsupportedProfileError";
	}
}

interface CryptoSuiteRegistry {
	active: ReadonlySet<string>;
	reserved: ReadonlySet<string>;
}

function cryptoSuiteField(document: RegistryDocument, kind: "epochAnchor" | "profile"): RegistryField {
	const field = document.kinds[kind]?.fields.find(({ name }) => name === "cryptoSuiteId");
	if (field === undefined) throw new TypeError(`registry kind ${kind} is missing cryptoSuiteId`);
	return field;
}

function enumStrings(field: RegistryField, constraintName: "reservedValues" | "values"): readonly string[] {
	const values = field.constraints[constraintName];
	if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
		throw new TypeError(`registry field ${field.name} requires string ${constraintName}`);
	}
	return values;
}

function loadCryptoSuiteRegistry(document: RegistryDocument): CryptoSuiteRegistry {
	const anchorField = cryptoSuiteField(document, "epochAnchor");
	const profileField = cryptoSuiteField(document, "profile");
	for (const field of [anchorField, profileField]) {
		if (field.type !== "enum" || field.constraints.negotiatedAt !== "genesis-only") {
			throw new TypeError(`registry field ${field.name} must be a genesis-only enum`);
		}
	}
	const activeValues = enumStrings(anchorField, "values");
	const reservedValues = enumStrings(anchorField, "reservedValues");
	if (
		activeValues.join("\0") !== enumStrings(profileField, "values").join("\0") ||
		reservedValues.join("\0") !== enumStrings(profileField, "reservedValues").join("\0")
	) {
		throw new TypeError("epochAnchor and profile crypto suite enumerations must match");
	}
	return {
		active: new Set(activeValues),
		reserved: new Set(reservedValues),
	};
}

/** Classifies a suite using the same registry path as genesis negotiation. */
export function cryptoSuiteStatus(
	suiteId: string,
	document: RegistryDocument = protocolRegistry()
): Exclude<CryptoSuiteStatus, "unsupported-by-peer"> {
	const cryptoSuites = loadCryptoSuiteRegistry(document);
	if (cryptoSuites.active.has(suiteId)) return "active";
	if (cryptoSuites.reserved.has(suiteId)) return "reserved";
	return "unknown";
}

/** Negotiates exactly the suite named by genesis, or fails closed. */
export function negotiateGenesisCryptoSuite(input: GenesisCryptoSuiteNegotiation): ActiveCryptoSuiteId {
	const status = cryptoSuiteStatus(input.namedSuiteId);
	if (status !== "active") {
		throw new UnsupportedProfileError(input.namedSuiteId, status);
	}
	if (!input.peerSuiteIds.includes(input.namedSuiteId)) {
		throw new UnsupportedProfileError(input.namedSuiteId, "unsupported-by-peer");
	}
	return input.namedSuiteId as ActiveCryptoSuiteId;
}
