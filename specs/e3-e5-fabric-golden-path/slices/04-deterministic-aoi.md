# Slice E4-00: Deterministic Area of Interest

## Contract

The same bounded world snapshot and observer interest produce the same ordered
visible entity set regardless of insertion order.

## API seam

Create `@ts-drp/aoi` with one pure owner:

```ts
interface AoiEntity {
  readonly id: string;
  readonly revision: number;
  readonly x: number;
  readonly y: number;
}

selectAreaOfInterest(input: {
  readonly center: { readonly x: number; readonly y: number };
  readonly entities: readonly AoiEntity[];
  readonly maxVisible: number;
  readonly radius: number;
}): readonly AoiEntity[];
```

Coordinates are safe-integer fixed point. Inclusion uses squared distance;
ties use entity ID. Reject duplicate IDs, unsafe values, invalid revisions and
over-limit collections.

## TDD and acceptance

Property tests cover permutation invariance, exact boundary inclusion,
deterministic ties, churn, cap 32, duplicate/malformed values and bounded work.
Target: <10 seconds.

## Human surface

Extend the fabric workbench with an AOI circle/grid overlay and highlighted
visible entities. Judge only selection/boundary readability; renderer art is out
of scope. Run screenshot critique, compare against the pre-AOI view, and use the
non-blocking preview window.

## Must stay green

E3 transport, zero durable movement, and existing grid rendering.

## Feedback that changes this slice

Only the fixed-point scale, boundary rule, or tie-breaker. Delta encoding and
bandwidth are later slices.
