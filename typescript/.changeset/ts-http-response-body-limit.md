---
"@x402/axios": patch
"@x402/fetch": patch
---

Bound 402 response bodies in the fetch and axios payment clients to 1 MiB, including paid-retry and recovery responses. A larger body throws `ResponseBodyTooLargeError`. Paid resource payloads are unchanged.
