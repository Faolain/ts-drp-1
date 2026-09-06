# D.110c-0c1f3 deterministic diagnostic trace

- Signed/pushed plan: `50b281e3dd9732a2dd7403992ec5336dcd96a0ce`.
- Signed/pushed causal RED: `c584b76bb7376fe2cbf4664dfdebacab8c153568`.
- The implementation draft is deliberately uncommitted and is diagnostic only.
- The focused protocol close passes after emitting one legacy carrier and one aggregate carrier. The two exact frontiers are Bob sequence 0 and Alice sequence 1.
- In the unchanged product RED, Bob's local issuance rows are:
  - sequence 0, epoch 0, action `join`, pending;
  - sequence 1, epoch 1, application message, published.
- Alice never observes Bob sequence 0 in her close graph. Her first aggregate records Bob `null`. At the next close, her graph contains Bob sequence 1, so the frozen prefix-from-zero rule leaves Bob `null`. The epoch-3 signerless Bob reopen still fails at predecessor admission.
- Diagnostic control only: Bob sends one epoch-zero application message before Alice's first close. That publishes and exposes Bob sequences 0 and 1 to Alice; the aggregate later reaches Bob sequence 2, historical classification succeeds for all three rows, and the epoch-3 signerless cold reopen passes after the recovery empty-chain predicate counts authenticated historical rows.
- The control is not an acceptable rewrite of the signed RED. It isolates the missing authority rule to a pending zero-intent pinned-genesis join that is locally authenticated but absent from the creator's close graph.

The review must not treat this trace as authority to cross a sequence gap. It must select an exact safe rule or require a further schema/architecture prerequisite.
