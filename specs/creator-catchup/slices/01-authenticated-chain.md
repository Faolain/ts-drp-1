# Authenticated checkpoint re-attachment

The seam accepts original authenticated local trust plus the remote latest signed predecessor/current checkpoint pair, Cut/QC, exact ACLs and settlement. It reuses `openCreatorCheckpointTrust` under the unchanged pinned creator identity, and returns an opaque operation-owned attachment capability bound to the exact local source and target. No full chain or service-window limit is required.

The final offer and snapshot must exactly match the target. Authenticate both remote anchors, Cut/QC equations, ACL hashes, signed settlement and profile. Reject wrong genesis, regressed target, tampering, forged keys and changed source identity before native mutation. Current role authority belongs to the target ACL. This proof deliberately does not classify local operations from skipped epochs.

Use native-produced checkpoint carriers as tests. Distances two, seven and hundreds have the same bounded proof shape. The focused transition model covers conserved unresolved work, separate local ancestry, floor phases, crash and terminal runtime fencing. Review this seam before depending on its capability in publication.

The draft transport carrier contains the remote predecessor's trust record (8,192 bytes maximum), ACL (65,536), and signed settlement (32,768), plus its canonical kind/version fields. Encoding all three maxima with the proposed schema costs 106,686 bytes. This is current-point evidence only; it cannot authenticate inclusion or exclusion of any earlier local operation. The final offered Cut/QC/current trust, snapshot and final settlement remain their existing carriers. Validate the full response and persisted receipt separately before adopting this layout.
