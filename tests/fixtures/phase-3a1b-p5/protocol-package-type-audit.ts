import type {
	AdmissionBoundTransactionalIssuerOptions,
	PreparedBlueprintAdmission,
	RawEd25519PublicKey,
	SignRegisteredVertexDigest,
	TransactIssue,
} from "@ts-drp/protocol-v3";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;

type ExpectedSigner = (registeredDigest: Uint8Array) => Promise<Uint8Array>;
type ExpectedCommon = Readonly<{
	author: string;
	preparedBlueprintAdmission: PreparedBlueprintAdmission;
	publicKey: RawEd25519PublicKey;
	transactIssue: TransactIssue;
}>;
type ExpectedOptions = ExpectedCommon &
	(
		| Readonly<{ privateKeySeed: Uint8Array; signRegisteredVertexDigest?: never }>
		| Readonly<{ privateKeySeed?: never; signRegisteredVertexDigest: ExpectedSigner }>
	);

type _SignerIsExact = Assert<Equal<SignRegisteredVertexDigest, ExpectedSigner>>;
type _OptionsAreExact = Assert<Equal<AdmissionBoundTransactionalIssuerOptions, ExpectedOptions>>;

declare const common: ExpectedCommon;
declare const signer: SignRegisteredVertexDigest;
declare function acceptOptions(options: AdmissionBoundTransactionalIssuerOptions): void;

const seedArm: AdmissionBoundTransactionalIssuerOptions = { ...common, privateKeySeed: new Uint8Array(32) };
const callbackArm: AdmissionBoundTransactionalIssuerOptions = { ...common, signRegisteredVertexDigest: signer };

// @ts-expect-error The application issuer accepts exactly one signing arm.
acceptOptions({ ...common, privateKeySeed: new Uint8Array(32), signRegisteredVertexDigest: signer });
// @ts-expect-error The application issuer accepts exactly one signing arm.
acceptOptions({ ...common });

void [seedArm, callbackArm];
export type ProtocolPackageSignerAudit = _SignerIsExact | _OptionsAreExact;
