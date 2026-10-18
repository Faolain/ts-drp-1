# Slice E3-00: Independent Delivery Lanes

## Contract

A pending reliable publication cannot block a later unreliable publication
before transport. Both lanes retain one combined queue bound and the existing
E2 receive authority.

## API seam

In `@ts-drp/ephemeral`:

```ts
export interface EphemeralTransportSendInput {
	readonly bytes: Uint8Array;
	readonly class: EphemeralDeliveryClass;
	readonly recipients: "all" | readonly string[];
}

interface EphemeralTransportPort {
	// Changed members only; existing peer, authority, ingress and close members remain.
	maxEnvelopeBytes(deliveryClass: EphemeralDeliveryClass): number;
	send(input: EphemeralTransportSendInput): Promise<boolean>;
}
```

Use independent reliable and unreliable drains. The combined retained-entry
count remains at most 256. Reliable retry remains reliable-only; unreliable
entries get one transport attempt. Latest-wins sequence replacement remains in
the ephemeral owner. Validate the detached frame against the transport-provided
class cap before it enters either queue. All classes retain the existing 65,536
byte reliable-carrier cap in this transitional slice; E3-02 replaces only the v3
raw-class cap with the route's remaining payload capacity. `publish()` uses
`recipients: "all"`. The later selective `publishTo()` must use this same port,
accept only unreliable classes, and reject any recipient that is not currently
E2-authorized.

## TDD and acceptance

Land a tests-only RED first. Hold a reliable send unresolved, publish
`unreliable-sequenced`, and require its class-aware transport call to complete
before reliable release. Also cover combined capacity, close settlement,
latest-wins replacement, per-class oversize rejection before queue telemetry,
detached bytes, all-recipient routing, stats, and the unchanged no-raw
preservation behavior.

GREEN changes `packages/ephemeral/src/index.ts` plus mechanical class-aware
adapter/fixture call shapes only. Production continues using its current
carrier until E3-02; record that as transitional and remove it there.

Run the new focused owner, corrected E2, zero-durable-vertices, ephemeral/node
typecheck and build, lint, formatting, and diff checks. Target: <30 seconds for
focused tests.

## Human surface

No new UI. The causal test timeline is the review surface.

## Must stay green

E1/E2 framing, authority, replay, budgets, stats, closure, current zone movement
semantics, and durable `placeBlock`.

## Feedback that changes this slice

Only evidence that a two-drain combined bound cannot be deterministic would
change the seam. WebRTC design does not belong here.
