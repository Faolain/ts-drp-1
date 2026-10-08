# Canonical RED matrix

| Gate | Selected | Passed | Failed | Skipped | Exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Phase-3g retained file | 14 | 13 | 1 | 0 | 1 |

The sole failure was
`preserves the authenticated legacy causalJoin source row as an application intent`.
The response assertion required the exact source author, author sequence 1,
authenticated source digest, and singleton intent:

```text
logicalTime=3
operation={action:"causalJoin"}
operationCount=1
operationIndex=0
```

Current production supplied `intents: []`, making this a causal RED rather
than a response-shape, setup, import, or export failure.
