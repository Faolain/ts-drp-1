# Explicitly deferred to parent f5b

- The first genuine every-peer authenticated pruning invocation after durable
  checkpoint staging, verified adoption, rollback retention, availability and
  expected-head eligibility.
- Behavioral proof that authenticated pruning is the first deleting issuance
  mutation and legacy pruning never runs first.
- The settlement-profile rollback-window recovery scan while preserving the
  creator-trusted-v1 one-epoch scan cap.

These are not claimed by this backend-only checkpoint. If parent f5b cannot
wire them without a wire/schema/public-API/authority/dependency/threshold
change, its existing stop-and-reslice rule applies.
