---
"@x402/core": patch
"@x402/mcp": patch
"@x402/evm": patch
---

Add `AfterSettleAbortError`: an `afterSettle` hook can throw it to fail an onchain-successful settle closed (`success: false`) while keeping transaction, amount, payer, and onchain extra. HTTP `PAYMENT-RESPONSE` and MCP `_meta` forward that receipt, and other `afterSettle` errors stay non-fatal. EVM batch-settlement deposit persistence failures now abort this way instead of surfacing as successful settles.
