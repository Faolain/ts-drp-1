# Bounded deferrals and implementation seams

These are ownership boundaries, not reasons to weaken or relabel the RED.

1. **Authenticated frontier classification — owner: D.110c-0c1f5b creator
   settlement/recovery integration.** The f5b0b Node seam intentionally returns
   exhaustive settlement sources until an authenticated checkpoint frontier is
   supplied. The room slice can remove a durable entry absent from an
   exhaustive source result, but it must not manufacture private checkpoint
   state or classify terminal/old-incarnation sources without the verified
   frontier.
2. **Migration-import refusal — owner: f5b0c GREEN with f5b integration if a
   genuine activated redirect is required.** The bounded public room harness
   cannot invoke the private owned-session redirect path without constructing
   migration/checkpoint authority that belongs to the parent integration. The
   GREEN implementation must fail closed for a settlement-profile migration
   import; its integration proof belongs with the real redirect/activation
   fixture rather than a private-state shortcut in this RED.
3. **Internal plan-effect typing — owner: f5b0c GREEN.** The f5b0b runtime
   accepts a structural `planEffect` on local issue, while exported
   `V3LocalIssueInput` does not expose it. Room implementation should use the
   already-reviewed internal seam without changing public `issue()` or adding a
   public product API. If that is impossible without a public contract change,
   the stop rule applies and the slice must be resliced.

