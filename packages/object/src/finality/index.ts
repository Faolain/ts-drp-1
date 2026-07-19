import { bls } from "@chainsafe/bls/herumi";
import { Logger } from "@ts-drp/logger";
import { isTracingEnabled, OpentelemetryMetrics } from "@ts-drp/tracer";
import {
	AggregatedAttestation,
	type Attestation,
	type FinalityConfig,
	type Hash,
	type IFinalityState,
	type IFinalityStore,
	type LoggerOptions,
} from "@ts-drp/types";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";

import { BitSet } from "../hashgraph/bitset.js";

const DEFAULT_FINALITY_THRESHOLD = 0.51;
const metrics = new OpentelemetryMetrics("@ts-drp/object/finality");

interface MergeSignatureStats {
	accepted: number;
	discarded: number;
}

/**
 * FinalityState is a class that implements the IFinalityState interface.
 * It represents the state of a vertex in the finality store.
 */
export class FinalityState implements IFinalityState {
	data: string;
	signerCredentials: string[];
	signerIndices: Map<string, number>;
	aggregation_bits: BitSet;
	signature?: Uint8Array;
	numberOfSignatures: number;

	/**
	 * Creates a new FinalityState instance.
	 * @param hash - The hash of the vertex.
	 * @param signers - The signers of the vertex.
	 */
	constructor(hash: Hash, signers: Map<string, string>) {
		this.data = hash;

		// deterministic order
		const peerIds = Array.from(signers.keys()).sort();
		this.signerCredentials = peerIds.map((peerId) => signers.get(peerId)).filter((c) => c !== undefined);

		this.signerIndices = new Map();
		for (let i = 0; i < peerIds.length; i++) {
			this.signerIndices.set(peerIds[i], i);
		}

		this.aggregation_bits = new BitSet(peerIds.length);
		this.numberOfSignatures = 0;
	}

	/**
	 * Adds a signature to the vertex.
	 * @param peerId - The peer ID of the signer.
	 * @param signature - The signature to add.
	 * @param verify - Whether to verify the signature.
	 */
	addSignature(peerId: string, signature: Uint8Array, verify = true): void {
		const index = this.signerIndices.get(peerId);
		if (index === undefined) {
			throw new Error("Peer not found in signer list");
		}

		if (!this.signerCredentials[index]) {
			throw new Error("Signer credentials not found");
		}

		if (this.aggregation_bits.get(index)) {
			// signer already signed
			return;
		}

		if (verify) {
			// verify signature validity
			const publicKey = uint8ArrayFromString(this.signerCredentials[index], "base64");
			const data = uint8ArrayFromString(this.data);
			if (!bls.verify(publicKey, data, signature)) {
				throw new Error("Invalid signature");
			}
		}

		this.aggregation_bits.set(index, true);
		if (!this.signature) {
			this.signature = signature;
		} else {
			this.signature = bls.aggregateSignatures([this.signature, signature]);
		}
		this.numberOfSignatures++;
	}

	/**
	 * Merges an attestation into the current state.
	 * @param attestation - The attestation to merge.
	 */
	merge(attestation: AggregatedAttestation): void {
		if (this.data !== attestation.data) {
			throw new Error("Hash mismatch");
		}
		const aggregationBits = new BitSet(this.signerCredentials.length, attestation.aggregationBits);
		for (let i = this.signerCredentials.length; i < attestation.aggregationBits.byteLength * 8; i++) {
			aggregationBits.set(i, false);
		}

		// public keys of signers who signed
		const publicKeys = this.signerCredentials
			.filter((_, i) => aggregationBits.get(i))
			.map((signer) => uint8ArrayFromString(signer, "base64"));
		const data = uint8ArrayFromString(this.data);

		// verify signature validity
		if (!bls.verifyAggregate(publicKeys, data, attestation.signature)) {
			throw new Error("Invalid signature");
		}

		const remoteCount = publicKeys.length;
		if (!this.signature) {
			this.aggregation_bits = aggregationBits;
			this.signature = attestation.signature;
			this.numberOfSignatures = remoteCount;
			return;
		}

		let overlapCount = 0;
		for (let i = 0; i < this.signerCredentials.length; i++) {
			if (this.aggregation_bits.get(i) && aggregationBits.get(i)) overlapCount++;
		}

		if (overlapCount === 0) {
			this.aggregation_bits = this.aggregation_bits.or(aggregationBits);
			this.signature = bls.aggregateSignatures([this.signature, attestation.signature]);
			this.numberOfSignatures += remoteCount;
			return;
		}

		// An aggregate signature cannot be split to remove overlapping signers. A
		// verified superset is safe to adopt; for partial overlap, retain whichever
		// verified aggregate covers more distinct signers rather than double-counting.
		if (
			overlapCount === this.numberOfSignatures ||
			(overlapCount < remoteCount && remoteCount > this.numberOfSignatures)
		) {
			this.aggregation_bits = aggregationBits;
			this.signature = attestation.signature;
			this.numberOfSignatures = remoteCount;
		}
	}
}

/**
 * Manages the finality states of vertices.
 */
export class FinalityStore implements IFinalityStore {
	states: Map<string, FinalityState>;
	finalityThreshold: number;

	private log: Logger;

	/**
	 * Creates a new FinalityStore instance.
	 * @param config @default undefined - The finality configuration.
	 * @param logConfig @default undefined - The logger configuration.
	 */
	constructor(config?: FinalityConfig, logConfig?: LoggerOptions) {
		this.states = new Map();
		this.finalityThreshold = config?.finality_threshold ?? DEFAULT_FINALITY_THRESHOLD;

		this.log = new Logger("drp::finality", logConfig);
	}

	/**
	 * Initializes a new state for a vertex.
	 * @param hash - The hash of the vertex.
	 * @param signers - The signers of the vertex.
	 */
	initializeState(hash: Hash, signers: Map<string, string>): void {
		if (!this.states.has(hash)) {
			this.states.set(hash, new FinalityState(hash, signers));
		}
	}

	/**
	 * Returns the number of signatures required for finality.
	 * @param hash - The hash of the vertex.
	 * @returns The quorum.
	 */
	getQuorum(hash: Hash): number | undefined {
		const state = this.states.get(hash);
		if (state === undefined) {
			return;
		}
		return Math.ceil(state.signerCredentials.length * this.finalityThreshold);
	}

	/**
	 * Returns the current number of signatures.
	 * @param hash - The hash of the vertex.
	 * @returns The number of signatures.
	 */
	getNumberOfSignatures(hash: Hash): number | undefined {
		return this.states.get(hash)?.numberOfSignatures;
	}

	/**
	 * Checks if a vertex has reached finality.
	 * @param hash - The hash of the vertex.
	 * @returns Whether the vertex has reached finality.
	 */
	isFinalized(hash: Hash): boolean | undefined {
		const numberOfSignatures = this.getNumberOfSignatures(hash);
		const quorum = this.getQuorum(hash);
		if (numberOfSignatures !== undefined && quorum !== undefined) {
			return numberOfSignatures >= quorum;
		}
	}

	/**
	 * Checks if a peer can sign a vertex.
	 * @param peerId - The peer ID of the signer.
	 * @param hash - The hash of the vertex.
	 * @returns Whether the peer can sign the vertex.
	 */
	canSign(peerId: string, hash: Hash): boolean | undefined {
		return this.states.get(hash)?.signerIndices.has(peerId);
	}

	/**
	 * Checks if a peer has signed a vertex.
	 * @param peerId - The peer ID of the signer.
	 * @param hash - The hash of the vertex.
	 * @returns Whether the peer has signed the vertex.
	 */
	signed(peerId: string, hash: Hash): boolean | undefined {
		const state = this.states.get(hash);
		if (state !== undefined) {
			const index = state.signerIndices.get(peerId);
			if (index !== undefined) {
				return state.aggregation_bits.get(index);
			}
		}
	}

	/**
	 * Adds signatures to vertices.
	 * @param peerId - The peer ID of the signer.
	 * @param attestations - The attestations to add.
	 * @param verify @default true - Whether to verify the signatures.
	 * @returns The added attestations.
	 */
	addSignatures(peerId: string, attestations: Attestation[], verify = true): Attestation[] {
		const added = [];
		for (const attestation of attestations) {
			try {
				this.states.get(attestation.data)?.addSignature(peerId, attestation.signature, verify);
				added.push(attestation);
			} catch (e) {
				this.log.warn("::finality::addSignatures", e);
			}
		}
		return added;
	}

	/**
	 * Retrieves the attestation for a vertex.
	 * @param hash - The hash of the vertex.
	 * @returns The attestation.
	 */
	getAttestation(hash: Hash): AggregatedAttestation | undefined {
		const state = this.states.get(hash);
		if (state !== undefined && state.signature !== undefined) {
			return AggregatedAttestation.create({
				data: state.data,
				aggregationBits: state.aggregation_bits.toBytes(),
				signature: state.signature,
			});
		}
	}

	/**
	 * Merges multiple signatures into their respective states.
	 * @param attestations - The attestations to merge.
	 */
	mergeSignatures(attestations: AggregatedAttestation[]): void {
		if (!isTracingEnabled()) {
			this.mergeSignaturesUntraced(attestations);
			return;
		}

		metrics.traceFunc(
			"finality.mergeSignatures",
			(batch: AggregatedAttestation[]) => this.mergeSignaturesUntraced(batch),
			(span, batch) => {
				span.setAttribute("drp.attestation.count", batch.length);
			},
			(span, result) => {
				span.setAttribute("drp.attestation.accepted_count", result.accepted);
				span.setAttribute("drp.attestation.discarded_count", result.discarded);
			}
		)(attestations);
	}

	private mergeSignaturesUntraced(attestations: AggregatedAttestation[]): MergeSignatureStats {
		let accepted = 0;
		let discarded = 0;
		for (const attestation of attestations) {
			const state = this.states.get(attestation.data);
			if (!state) {
				discarded++;
				continue;
			}
			try {
				state.merge(attestation);
				accepted++;
			} catch (e) {
				discarded++;
				this.log.warn("::finality::mergeSignatures", {
					hash: attestation.data,
					errorName: e instanceof Error ? e.name : "UnknownError",
				});
			}
		}
		return { accepted, discarded };
	}
}
