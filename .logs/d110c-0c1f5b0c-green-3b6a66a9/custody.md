# Custody

- Branch: `codex/phase3a1b-p6-golden-path`.
- Accepted design: `.logs/d110c-0c1f5b0r-design-3a156aca/`; its manifest
  validated before implementation.
- Tests-only RED: signed `d062c5f64ad7255f67eb91d0eb1c8441acc147c1`.
- RED evidence anchor: signed `9f55370c7f7da926f86f6e308703f7541c522337`.
- Production GREEN: signed
  `3b6a66a9b5257c9011611fc2955ac6ee1ab90bfc`, tree
  `b2426c1d695979e68abaf45a5d2859a537e59b52`, signer fingerprint
  `55E22F154FBAF8C84F378304761B99CEA81C6289`.
- At evidence capture, the remote branch matched production GREEN.
- Production changed exactly `examples/v3-room/src/index.ts`; its SHA-256 is
  `bf4721b35128469dca16bc5aa2a24fc66377c4fc14c806b7e6472ffad831b4ac`.
- `production.diff` SHA-256 before manifest creation is
  `1a8bb4fd203b603046d3d66cec5e442efc6b0b3d90a2b25f0c6208ba564a75c2`.
- Twenty-seven existing stashes were preserved; their listing SHA-256 is
  `4d9c869056a52e1cc9f27b51455ddd10063c0ad9e8f0b653667678ccb0be9537`.
- Protected untracked paths were not added, removed, or modified.
- No plan, dependency, lockfile, campaign, long workload, wire, schema,
  cryptography, or public API change is included.
