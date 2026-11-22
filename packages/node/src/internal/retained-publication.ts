/**
 * The room's retained publisher serves a peer's retained-history request from the session's
 * current plane. Some failures are a cancellation of that publication, not a publication fault,
 * and the publisher returns instead of rejecting:
 *
 * - An orderly close (f9828cd0): the close revokes the transport synchronously and retires the
 *   plane later, so a publication in flight ends `not-active` or `publication-state-unknown`, or
 *   `publish-failed` when the revoked transport refused the send while the plane was still current.
 * - The session's own successor (Track Z): a creator adoption or a recipient install retires the
 *   plane the publication read. A send in flight then ends `publication-state-unknown`, and a
 *   publication that starts in the activation window ends `not-active`. The successor plane serves
 *   the next request. This applies only to those two kinds (the plane is no longer current), and
 *   only once the session has moved past that plane or while the transition replacing it runs.
 *
 * Storage and record faults (`store-failed`, `record-rejected`), `admission-rejected`, a
 * `publish-failed` outside an orderly close, and every failure after a terminal failure still reject.
 * Local error classification only; it grants and decides nothing.
 */
export type RetainedPublicationState = Readonly<{
	/** The session recorded a terminal failure. */
	terminal: boolean;
	/** The session's orderly close has begun. */
	closing: boolean;
	/**
	 * The session's active plane is no longer the one the publication read, or a creator adoption or
	 * recipient install that replaces it is in flight.
	 */
	superseded: boolean;
}>;

/**
 * Whether a failed retained publication was cancelled (the publisher returns) rather than faulted (it rejects).
 * @param kind - The plane's egress failure kind.
 * @param state - The serving session's state when the publication returned.
 * @returns True for a cancellation.
 */
export function retainedPublicationCancelled(kind: string, state: RetainedPublicationState): boolean {
	if (state.terminal) return false;
	const retired = kind === "not-active" || kind === "publication-state-unknown";
	if (state.closing) return retired || kind === "publish-failed";
	return state.superseded && retired;
}
