The first wrapper invocation stopped before readiness, capture or any reviewer
launch with ENOENT. Inherited frozen input keys include absolute isolated-checkout
paths; joining them to the repository root incorrectly prepended that root.
The wrapper now resolves absolute keys unchanged and relative keys under the
repository root. No missing input was dropped, custody condition weakened,
reviewer restarted or runtime gate attempted.
