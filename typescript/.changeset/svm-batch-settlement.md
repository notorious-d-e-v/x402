---
"@x402/svm": minor
---

Added an SVM `batch-settlement` implementation for long-lived payment channels and cumulative offchain vouchers. Reuses the `upto` payment-channel primitives, adds client-signed vouchers and concurrent server-signed metering with itemized receipts, batched claim/distribution operations, payer-forced close and grace-period finalization, and onchain facilitator recovery. Ships dedicated client, server, and facilitator entry points.

Recovery preserves signed transactions before submission, constrains postcondition reads to the confirmation slot, and reconciles actual payouts and merchant paid state without new distribution request fields. Includes replaceable recovery storage and an idempotent payout-recording callback. A broadcast whose blockhash has expired with no record of its signature is reported as `transaction_failed` and released rather than left pending, reads rejected for the confirmation-slot floor are retried, and a payout whose attribution is ambiguous is answered with `invalid_batch_settlement_svm_payout_attribution_ambiguous` and released. The facilitator signer gains an optional `isBlockhashValid` capability.
