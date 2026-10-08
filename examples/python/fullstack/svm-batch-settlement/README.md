# Solana batch settlement: local Python smoke

This runs a Python client over real loopback HTTP against the shipped Flask payment middleware. The merchant uses a remote facilitator; the client and assertions use your configured Solana RPC. It exercises one deposit, three paid requests, channel-manager claim/distribution, and cooperative refund. Run each network and voucher mode with a separate state directory.

Defaults are 10,000 USDC atomic units ($0.01) deposited, three requests at 100 units ($0.0001) each, and a 10,000-unit total escrow cap. Expected total charges are 300 units and refund 9,700 units. Merchant receipts can be lower than gross charges when the deployed program takes protocol fees. The harness checks the actual distribution receipt against the merchant's token balance.

The default facilitator is `https://facilitator.payai.network`. Preflight requires an advertised v2 `batch-settlement` kind for the selected network and its USDC mint, sufficient deposit, and a supported withdrawal delay. An `exact` kind alone is insufficient. The harness never changes facilitator endpoints automatically.

## Setup

Install Python 3.10+ and current uv, then from this directory:

```sh
uv sync
```

Keep your config and state outside the checkout. Use dedicated payer and recipient wallets with no concurrent activity so balance deltas are attributable to this run. The recipient must differ from the payer. The payer must hold the selected network's USDC. Deposits use the facilitator's advertised fee payer.

Create a private JSON config, for example `~/.local/share/x402-smoke/mainnet-client.json`:

```json
{
  "network": "mainnet",
  "facilitator": "https://facilitator.payai.network",
  "rpc_url": "https://YOUR_SOLANA_MAINNET_RPC",
  "payer_key_file": "/absolute/path/to/dedicated-solana-keypair.json",
  "payee": "YOUR_DISTINCT_RECIPIENT_PUBLIC_KEY",
  "mode": "client",
  "deposit": 10000,
  "max_deposit": 10000,
  "price": 100,
  "requests": 3
}
```

Set the config/key permissions to `600` and their directory permissions to `700`. The key file may contain a Solana JSON byte array or a base58 keypair. Secrets and credentialed RPC URLs are never included in the report. The harness generates and persists a separate local receiver-authorizer key. In `server` mode, that key also signs vouchers and is explicitly granted authority over at most `max_deposit` units by the local client.

For Devnet, set `network` to `devnet` and provide a Devnet RPC and Devnet USDC wallet. Keep the production facilitator unless you explicitly intend to test another deployment. For server vouchers, change `mode` to `server` in a separate config. Optional `actual: 60` tests metered charges below the 100-unit authorization ceiling; its expected total/refund are 180/9,820 units.

## Run

Preflight reads `/supported` only and needs neither a wallet nor state directory; a config containing only `network` and optionally `facilitator` is sufficient:

```sh
uv run python smoke.py preflight --config ~/.local/share/x402-smoke/mainnet-client.json
```

Start a funded run only after choosing the intended wallet, network and facilitator:

```sh
uv run python smoke.py run \
  --config ~/.local/share/x402-smoke/mainnet-client.json \
  --state-dir ~/.local/share/x402-smoke/mainnet-client-state \
  > ~/.local/share/x402-smoke/mainnet-client-report.json
```

`run` requires fresh state. `--stop-after payments` leaves funds in escrow after the three paid requests; `--stop-after redeem` also claims and distributes charges. Without that option, the run refunds unspent funds and verifies closure. The report contains channel IDs, transaction signatures, charges, balance snapshots, and passed assertions. `complete: true` requires all refund and balance assertions to pass.

The first HTTP payment submits the deposit; subsequent paid requests must have empty transaction receipts. The manager then submits claim and distribution. Refund must use the middleware's skip-handler settlement path and cooperatively close the escrow. The harness checks confirmed chain watermarks, payer/recipient USDC deltas, refund amount, and escrow token-account closure. Read assertions retry briefly for RPC lag; transactions are not retried by that loop. Top-ups are deliberately excluded so a run cannot exceed its one-deposit budget.

## Resume and recovery

```sh
uv run python smoke.py status --state-dir ~/.local/share/x402-smoke/mainnet-client-state
uv run python smoke.py resume \
  --config ~/.local/share/x402-smoke/mainnet-client.json \
  --state-dir ~/.local/share/x402-smoke/mainnet-client-state
```

Resume requires the original configuration, keys and state. A private SQLite database persists client channel records, merchant accounting, request IDs, signed payloads, remote settlement requests/responses, and exact HTTP responses. Completed HTTP operations replay their saved response without charging again. A process lock prevents concurrent runs against the same state directory. This small, single-process journal is an example, not a production persistence adapter.

An interruption after a remote request started but before its outcome was saved stops automatic recovery. Likewise, a merchant operation recorded as started without a saved response is not rerun. The report marks unknown remote outcomes with `outcomeKnown: false`. A returned `settlement_pending` or failed paid response is retained and not blindly retried. Preserve the directory and inspect its private `state.sqlite3` alongside onchain transactions before resolving that outcome. The signed payloads, channel configuration, vouchers and local authorizer key remain available for deliberate protocol recovery. Do not delete state or start another funded run to work around an unresolved deposit. Automated reconciliation of ambiguous broadcasts or forced-close recovery is outside this smoke's scope.

`status` reads only local state. Keep the database and `operator.json` private: they contain usable payment authorizations and a signing key. Only share the redacted JSON report. Concurrent wallet activity or a lagging RPC can fail a balance assertion even when a transaction succeeded; inspect the saved receipt before taking further action.

## Local checks

These tests use real localhost HTTP and SDK signatures, with mocked remote settlement/RPC state; they never contact a live endpoint or move funds:

```sh
uv run pytest -q test_smoke.py
```
