# Slice 02: Serialized Activation and Ingress

Activation consumes only the recovered capability. It removes the caller-owned
author resolver and direct prepared-to-live bypass.

One gate owns recovery completion, ingress, future local issue and egress. Live
ingress is ordered as authentication and admission, journal append, index append,
then post-commit observation. Subscription begins only after recovery succeeds.
