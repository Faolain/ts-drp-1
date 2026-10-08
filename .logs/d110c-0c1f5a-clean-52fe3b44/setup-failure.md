# D.110c-0c1f5a isolated setup diagnostic

This root is not the accepted isolated proof. The requested checkout used the
incorrect expanded hash `52fe3b44e30a946f42bea2095d1ea2a85c0f72a9` and stopped with checkout status
128 before any f5a test ran. The worktree remained at the preceding signed RED
anchor. Verification and offline installation therefore describe that
unchanged anchor, not GREEN. The fresh sibling root ending in `-v2` uses the
actual signed GREEN commit and is the accepted proof.
