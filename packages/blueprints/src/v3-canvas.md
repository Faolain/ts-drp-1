# Additive RGB canvas v1

This pure v3 application schema preserves the original Canvas/Pixel capability:
per-channel additive counters, displayed modulo 256, pixel counter queries and
valid rectangular splash. It is not the zone's last-writer overwrite operation.

The admitted domain is integer dimensions 1–64 (at most 4096 pixels), integer RGB
increments 0–255, and nonnegative counters at most `Number.MAX_SAFE_INTEGER`.
These include the existing 10×10 UI and its RGB range; malformed legacy bounds,
fractions/negative inputs and its erroneous splash loop are not preserved.
An operation either produces a complete immutable successor or throws: no
partial splash can escape on a later channel overflow. At capacity, admission
must refuse; this does not promise unlimited progress or automatic counter reset.

One self-contained kernel owns state capture, paint/splash, queries and artifact
reducers. The descriptor uses that same transition for projection and canonical
snapshot restoration. Dimensions must agree on restore. The artifact export is
prospective v3 synchronous blueprint shape. Direct-module unit invocation is not
actual artifact toolchain admission: the shipped zone source currently rewrites
its single export declaration into the artifact entry. This module's exports
need genuine toolchain/catalog integration before a shipped host may activate it.

Snapshot limits follow the existing canonical codec, not storage policy: depth
3, at most 8 decoder items per pixel plus 17 header items, and a conservative
128-byte header plus 29 bytes per pixel. Signed zero is normalized to zero so
restoration and direct fold share the same counter domain.

Projection deduplicates already-authenticated vertex digest + batch operation
index within the current epoch and rejects conflicting retry values. Different
signed vertices with identical RGB still add independently. Kernel `apply` has
no retry registry and executes each invocation; protocol admission owns signed
identity. The base must be the prior epoch's authenticated snapshot, and all new
rows must belong to the current epoch. This explicit boundary refuses folding
the prior snapshot's rows again. Epoch/digest inputs are structural obligations,
not a signature/ACL/freshness proof; the original room owner must authenticate
them and bind the base to its actual signed snapshot.
Authors and digests must have the existing 64-lowercase-hex structural shape.
Retry equality uses a closed 192-byte/depth-3/39-item codec bound, not the default
large canonical budget. Shape and bounds still do not authenticate the author.

Remaining composition: trusted artifact/catalog evidence, bootstrap operation,
the real canvas UI create/join/session and authority-bearing invite, native
snapshot/host/floor and close/recovery ownership, signed current Writer admission,
render/subscription/error handling and real peer/restart acceptance. No host,
catalog receipt, signer, profile or network port is manufactured here. The old
canvas remains unchanged until that genuine port exists.
