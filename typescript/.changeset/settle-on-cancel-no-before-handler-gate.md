---
"@x402/core": patch
"@x402/evm": patch
"@x402/svm": patch
---

Call scheme `settleOnCancel` even when no before-handler settle has completed, passing the completed `settledPhases` so the scheme decides. A failure-path receipt includes a cancel settle only when a before-handler settlement exists; otherwise it echoes that settlement or is omitted, and MCP rethrows the handler error when there is no failure receipt. SVM `upto` and auth-capture `settleOnCancel` return nothing unless the before-handler settle already completed.
