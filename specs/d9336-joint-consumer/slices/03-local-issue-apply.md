# Slice 03: Local Issue, Apply and Publish

Add one local durable operation path using the P6-resolved author, the shipped
admission-bound issuer and the same serialized apply gate.

The order is durable issue, journal local reference, index append, visible
observation and pending publication. Recovery must collapse every crash boundary
without fabricating a row, reusing a sequence or repeating an effect.
