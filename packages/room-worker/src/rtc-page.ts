/**
 * Page side of the room worker's WebRTC split. Dedicated workers expose RTCDataChannel but not
 * RTCPeerConnection, so the page owns the real peer connections: the worker's signalling calls
 * (offers, answers, descriptions, ICE) run here, and every data channel, created here or received,
 * is transferred to the worker at once. After setup no data-channel byte touches the main thread.
 */

type Post = (message: unknown, transfer?: Transferable[]) => void;

export type WorkerToPageRtc =
	| Readonly<{ t: "new"; id: number; configuration?: RTCConfiguration }>
	| Readonly<{ t: "call"; id: number; call: number; method: string; args: unknown[] }>
	| Readonly<{ t: "createDataChannel"; id: number; wid: number; label: string; init: RTCDataChannelInit }>
	| Readonly<{ t: "close"; id: number }>;

export interface PeerConnectionState {
	readonly connectionState: RTCPeerConnectionState;
	readonly iceConnectionState: RTCIceConnectionState;
	readonly iceGatheringState: RTCIceGatheringState;
	readonly signalingState: RTCSignalingState;
	readonly localDescription: RTCSessionDescriptionInit | null;
	readonly remoteDescription: RTCSessionDescriptionInit | null;
	readonly sctp: Readonly<{ maxMessageSize: number; state: string; transport: Readonly<{ state: string }> }> | null;
}

export type PageToWorkerRtc =
	| Readonly<{ t: "state"; id: number; s: PeerConnectionState; event?: string; candidate?: RTCIceCandidateInit | null }>
	| Readonly<{ t: "result"; call: number; ok: boolean; value?: unknown; error?: string }>
	| Readonly<{ t: "datachannel"; id: number; channel: RTCDataChannel }>
	| Readonly<{ t: "channel"; wid: number; channel: RTCDataChannel }>;

const description = (
	value: RTCSessionDescription | RTCSessionDescriptionInit | null
): RTCSessionDescriptionInit | null => (value === null ? null : { type: value.type, sdp: value.sdp ?? "" });

function snapshot(pc: RTCPeerConnection): PeerConnectionState {
	const sctp = pc.sctp;
	return {
		connectionState: pc.connectionState,
		iceConnectionState: pc.iceConnectionState,
		iceGatheringState: pc.iceGatheringState,
		signalingState: pc.signalingState,
		localDescription: description(pc.localDescription),
		remoteDescription: description(pc.remoteDescription),
		sctp:
			sctp === null || sctp === undefined
				? null
				: { maxMessageSize: sctp.maxMessageSize, state: sctp.state, transport: { state: sctp.transport.state } },
	};
}

const STATE_EVENTS = [
	"connectionstatechange",
	"iceconnectionstatechange",
	"icegatheringstatechange",
	"signalingstatechange",
	"negotiationneeded",
	"icecandidateerror",
] as const;

export interface PageRtcHost {
	receive(message: unknown): void;
	close(): void;
}

/**
 * Creates the page host of the worker's peer connections.
 * @param post - Posts an RTC message to the worker.
 * @returns The host.
 */
export function createPageRtcHost(post: Post): PageRtcHost {
	const connections = new Map<number, RTCPeerConnection>();
	const run = async (pc: RTCPeerConnection, method: string, args: unknown[]): Promise<unknown> => {
		switch (method) {
			case "createOffer":
				return description(await pc.createOffer(args[0] as RTCOfferOptions | undefined));
			case "createAnswer":
				return description(await pc.createAnswer(args[0] as RTCAnswerOptions | undefined));
			case "setLocalDescription":
				return pc.setLocalDescription(args[0] as RTCSessionDescriptionInit | undefined);
			case "setRemoteDescription":
				return pc.setRemoteDescription(args[0] as RTCSessionDescriptionInit);
			case "addIceCandidate":
				return pc.addIceCandidate(args[0] as RTCIceCandidateInit | undefined);
			case "getStats":
				return Array.from((await pc.getStats()).entries());
			default:
				throw new Error(`RTC method ${method} is not bridged`);
		}
	};
	return {
		receive(raw: unknown): void {
			const message = raw as WorkerToPageRtc;
			switch (message.t) {
				case "new": {
					const pc = new RTCPeerConnection(message.configuration);
					const id = message.id;
					connections.set(id, pc);
					for (const name of STATE_EVENTS)
						pc.addEventListener(name, () => post({ t: "state", id, s: snapshot(pc), event: name }));
					pc.addEventListener("icecandidate", (event) =>
						post({
							t: "state",
							id,
							s: snapshot(pc),
							event: "icecandidate",
							candidate: event.candidate?.toJSON() ?? null,
						})
					);
					pc.addEventListener("datachannel", (event) => {
						post({ t: "state", id, s: snapshot(pc) });
						post({ t: "datachannel", id, channel: event.channel }, [event.channel as unknown as Transferable]);
					});
					return;
				}
				case "call": {
					const pc = connections.get(message.id);
					const { id, call } = message;
					if (pc === undefined) {
						post({ t: "result", call, ok: false, error: "RTCPeerConnection is closed" });
						return;
					}
					run(pc, message.method, message.args).then(
						(value) => {
							post({ t: "state", id, s: snapshot(pc) });
							post({ t: "result", call, ok: true, value });
						},
						(error: unknown) => {
							post({ t: "state", id, s: snapshot(pc) });
							post({ t: "result", call, ok: false, error: String(error) });
						}
					);
					return;
				}
				case "createDataChannel": {
					const pc = connections.get(message.id);
					if (pc === undefined) return;
					const channel = pc.createDataChannel(message.label, message.init);
					post({ t: "channel", wid: message.wid, channel }, [channel as unknown as Transferable]);
					return;
				}
				case "close":
					connections.get(message.id)?.close();
					connections.delete(message.id);
					return;
			}
		},
		close(): void {
			for (const pc of connections.values()) pc.close();
			connections.clear();
		},
	};
}
