import assert from "node:assert/strict";
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { writeFileSync } from "node:fs";

import { createKeyPairSignerFromBytes, getAddressDecoder } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS, USDC_DEVNET_ADDRESS } from "@x402/svm";
import { BatchSvmScheme as BatchClientScheme } from "@x402/svm/batch-settlement/client";
import {
  BatchChannelManager,
  BatchSvmScheme as BatchServerScheme,
} from "@x402/svm/batch-settlement/server";

const NETWORK = SOLANA_DEVNET_CAIP2;
const PRICE = "1000";
const DEPOSIT = "3000";
const WITHDRAW_DELAY = 900;
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://dev-facilitator.payai.network";
const EXPECTED_CLIENT = "5eQtwDgsWjts7LhzfRQKHntKhsJsv2c8JdsHDNdZHqRW";
const EXPECTED_RECEIVER = "BXqAoniSJzKFG1on9f42tjTtSC3RDvn9DHookrovjoW8";
const EXPECTED_FEE_PAYER = "DJwbH2X5VuUycmN9iw42gTppNG71Bze8w79Tpm63BdQT";
const RESTART_PAUSE_MS = Number(process.env.RESTART_PAUSE_MS ?? 150_000);
const RECLAIM_TIMEOUT_MS = Number(process.env.RECLAIM_TIMEOUT_MS ?? 1_500_000);
const RPC_URL = required("RPC_URL_SOLANA_DEVNET");
let phase = "startup";

function reportTermination(result) {
  writeFileSync("/dev/termination-log", json(result), { mode: 0o600 });
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const json = value =>
  JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item));

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]);
}

function decodeSvmKey(raw) {
  const trimmed = raw.trim();
  const bytes = trimmed.startsWith("[")
    ? Uint8Array.from(JSON.parse(trimmed))
    : Uint8Array.from(Buffer.from(trimmed, "base64"));
  if (bytes.length !== 64) throw new Error(`SVM key decoded to ${bytes.length} bytes, expected 64`);
  return bytes;
}

function createJwt() {
  const keyId = required("PAYAI_API_KEY_ID");
  const raw = required("PAYAI_API_KEY_SECRET");
  if (!raw.startsWith("payai_sk_")) throw new Error("unexpected PayAI key encoding");
  const privateKey = createPrivateKey({
    key: Buffer.from(raw.slice("payai_sk_".length), "base64"),
    format: "der",
    type: "pkcs8",
  });
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "EdDSA", typ: "JWT", kid: keyId });
  const payload = encode({
    sub: keyId,
    iss: "payai",
    iat: now,
    exp: now + 120,
    jti: randomBytes(16).toString("hex"),
  });
  const message = `${header}.${payload}`;
  return `${message}.${sign(null, Buffer.from(message), privateKey).toString("base64url")}`;
}

const rpcMetrics = new Map();
async function rpc(method, params) {
  const started = performance.now();
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  const metric = rpcMetrics.get(method) ?? { count: 0, ms: [] };
  metric.count += 1;
  metric.ms.push(performance.now() - started);
  rpcMetrics.set(method, metric);
  if (!response.ok || body.error) {
    throw new Error(`${method} failed: ${body.error?.message ?? response.status}`);
  }
  return body.result;
}

async function accountInfo(address) {
  return (await rpc("getAccountInfo", [address, { commitment: "confirmed", encoding: "base64" }]))
    .value;
}

function decodeChannel(value) {
  if (!value) return undefined;
  const data = Buffer.from(value.data[0], "base64");
  assert.equal(data.length, 256, "unexpected channel account size");
  const addressDecoder = getAddressDecoder();
  const addressAt = offset => addressDecoder.decode(data.subarray(offset, offset + 32));
  return {
    version: data.readUInt8(1),
    bump: data.readUInt8(2),
    status: data.readUInt8(3),
    salt: data.readBigUInt64LE(4),
    deposit: data.readBigUInt64LE(12),
    settlement: {
      settled: data.readBigUInt64LE(20),
      payoutWatermark: data.readBigUInt64LE(28),
    },
    closureStartedAt: data.readBigInt64LE(36),
    payerWithdrawnAt: data.readBigInt64LE(44),
    gracePeriod: data.readUInt32LE(52),
    distributionHash: Uint8Array.from(data.subarray(56, 88)),
    payer: addressAt(88),
    payee: addressAt(120),
    authorizedSigner: addressAt(152),
    mint: addressAt(184),
    rentPayer: addressAt(216),
    openSlot: data.readBigUInt64LE(248),
  };
}

async function channelSnapshot(channelId) {
  const [channelValue, mintValue] = await Promise.all([
    accountInfo(channelId),
    accountInfo(USDC_DEVNET_ADDRESS),
  ]);
  if (!channelValue || !mintValue) return undefined;
  return {
    channel: decodeChannel(channelValue),
    mintOwner: String(mintValue.owner),
    observedAt: Date.now(),
  };
}

async function usdcBalance(owner) {
  const result = await rpc("getTokenAccountsByOwner", [
    owner,
    { mint: USDC_DEVNET_ADDRESS },
    { commitment: "confirmed", encoding: "jsonParsed" },
  ]);
  return result.value.reduce(
    (total, row) => total + BigInt(row.account.data.parsed.info.tokenAmount.amount),
    0n,
  );
}

async function solBalance(owner) {
  return BigInt((await rpc("getBalance", [owner, { commitment: "confirmed" }])).value);
}

class DurableChannelStore {
  durable = true;
  channels = new Map();
  locks = new Map();
  leases = new Map();

  async get(channelId) {
    return this.channels.get(channelId);
  }

  async list() {
    return [...this.channels.values()];
  }

  async put(state) {
    this.channels.set(state.channelId, state);
  }

  async update(channelId, updater) {
    const prior = this.locks.get(channelId) ?? Promise.resolve();
    const run = prior.then(async () => {
      const next = await updater(this.channels.get(channelId));
      this.channels.set(channelId, next);
      return next;
    });
    this.locks.set(
      channelId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async acquireLease(key) {
    if (this.leases.has(key)) return undefined;
    const token = Symbol(key);
    this.leases.set(key, token);
    return async () => {
      if (this.leases.get(key) === token) this.leases.delete(key);
    };
  }
}

class DurableClientStorage {
  records = new Map();
  async get(key) {
    return this.records.get(key);
  }
  async set(key, record) {
    this.records.set(key, structuredClone(record));
  }
  async delete(key) {
    this.records.delete(key);
  }
}

class MeasuredFacilitator {
  constructor(inner) {
    this.inner = inner;
    this.calls = { supported: [], verify: [], settle: [] };
  }

  async timed(operation, action) {
    const started = performance.now();
    try {
      return await action();
    } finally {
      this.calls[operation].push(performance.now() - started);
    }
  }

  getSupported() {
    return this.timed("supported", () => this.inner.getSupported());
  }
  verify(payload, requirements) {
    return this.timed("verify", () => this.inner.verify(payload, requirements));
  }
  settle(payload, requirements) {
    return this.timed("settle", () => this.inner.settle(payload, requirements));
  }
}

async function main() {
  phase = "decode_signers";
  const clientSigner = await createKeyPairSignerFromBytes(
    decodeSvmKey(required("SVM_CLIENT_PRIVATE_KEY")),
  );
  const receiverSigner = await createKeyPairSignerFromBytes(
    decodeSvmKey(required("SVM_RECEIVER_PRIVATE_KEY")),
  );
  assert.equal(clientSigner.address, EXPECTED_CLIENT);
  assert.equal(receiverSigner.address, EXPECTED_RECEIVER);

  const http = new HTTPFacilitatorClient({
    url: FACILITATOR_URL,
    timeoutMs: 120_000,
    createAuthHeaders: async () => {
      const authorization = `Bearer ${createJwt()}`;
      return {
        supported: { Authorization: authorization },
        verify: { Authorization: authorization },
        settle: { Authorization: authorization },
      };
    },
  });
  const facilitator = new MeasuredFacilitator(http);
  phase = "supported";
  const supported = await facilitator.getSupported();
  const batchKind = supported.kinds.find(
    kind =>
      kind.x402Version === 2 && kind.scheme === "batch-settlement" && kind.network === NETWORK,
  );
  assert(batchKind, "authenticated /supported omitted devnet batch-settlement");
  assert.equal(batchKind.extra?.experimental, true);
  assert.equal(batchKind.extra?.feePayer, EXPECTED_FEE_PAYER);

  const serverStore = new DurableChannelStore();
  const clientStorage = new DurableClientStorage();
  const responseCache = new Map();
  let server;
  let serverScheme;
  let client;
  let clientScheme;
  let applicationExecutions = 0;

  const restartServer = async () => {
    serverScheme = new BatchServerScheme({
      store: serverStore,
      requireDurableStore: true,
      withdrawDelay: WITHDRAW_DELAY,
      channelSnapshotMaxAgeMs: 0,
      readChannel: async ({ channelId }) => channelSnapshot(channelId),
      getReplayResponse: async ({ commitmentId }) => responseCache.get(commitmentId),
    });
    server = new x402ResourceServer(facilitator);
    server.register(NETWORK, serverScheme);
    await server.initialize();
  };
  const restartClient = () => {
    clientScheme = new BatchClientScheme(clientSigner, {
      channelStorage: clientStorage,
      depositAmount: DEPOSIT,
      rpcUrl: RPC_URL,
    });
    client = new x402Client().register(NETWORK, clientScheme);
  };
  phase = "initialize_sdk";
  await restartServer();
  restartClient();

  const baseRequirements = [
    {
      scheme: "batch-settlement",
      network: NETWORK,
      amount: PRICE,
      asset: USDC_DEVNET_ADDRESS,
      payTo: receiverSigner.address,
      maxTimeoutSeconds: 300,
      extra: {
        feePayer: batchKind.extra.feePayer,
        paymentFlow: "authorization",
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: WITHDRAW_DELAY,
      },
    },
  ];
  const resource = { url: "https://dev-smoke.payai.network/paid" };
  const paymentRequired = () => server.createPaymentRequiredResponse(baseRequirements, resource);

  async function execute(payload, requirements, countApplication = true) {
    const matched = server.findMatchingRequirements([requirements], payload);
    assert(matched, "resource server did not match batch requirements");
    const verified = await server.verifyPayment(payload, matched);
    assert.equal(verified.isValid, true, json(verified));
    if (countApplication) applicationExecutions += 1;
    const settled = await server.settlePayment(payload, matched);
    assert.equal(settled.success, true, json(settled));
    const commitmentId = settled.extra?.commitmentId;
    if (countApplication && commitmentId) {
      responseCache.set(commitmentId, { body: { ok: true, applicationExecutions } });
    }
    return { matched, settled };
  }

  phase = "initial_balances";
  const before = {
    clientUsdc: await usdcBalance(clientSigner.address),
    receiverUsdc: await usdcBalance(receiverSigner.address),
    feePayerSol: await solBalance(EXPECTED_FEE_PAYER),
    feePayerUsdc: await usdcBalance(EXPECTED_FEE_PAYER),
  };
  assert.equal(before.clientUsdc, 50_000n);
  assert.equal(before.feePayerSol <= 50_000_000n, true);
  assert.equal(before.feePayerUsdc <= 5_000_000n, true);

  phase = "open_requirements";
  const firstRequired = await paymentRequired();
  const firstRequirements = firstRequired.accepts.find(item => item.scheme === "batch-settlement");
  assert(firstRequirements);
  phase = "open_requirement_fee_payer";
  assert.equal(firstRequirements.extra?.feePayer, EXPECTED_FEE_PAYER);
  phase = "open_requirement_withdraw_delay";
  assert.equal(firstRequirements.extra?.withdrawDelay, WITHDRAW_DELAY);
  phase = "open_requirement_token_program";
  assert.equal(firstRequirements.extra?.tokenProgram, TOKEN_PROGRAM_ADDRESS);

  phase = "open_create_payload";
  const first = await client.createPaymentPayload(firstRequired);
  assert.equal(first.payload.type, "deposit");
  phase = "open_verify_settle";
  const firstResult = await execute(first, firstRequirements);
  const channelId = first.payload.voucher.channelId;
  phase = "open_chain_snapshot";
  const opened = await channelSnapshot(channelId);
  assert(opened);
  assert.equal(opened.channel.status, 0);
  assert.equal(opened.channel.deposit, 3_000n);
  phase = "open_server_store";
  assert.equal((await serverStore.get(channelId)).chargedCumulativeAmount, 1_000n);

  phase = "lost_response_replay";
  // Simulate a response lost after the request and open transaction landed.
  await clientScheme.schemeHooks.onPaymentResponse({
    error: new Error("simulated response loss after server commit"),
    paymentPayload: first,
    requirements: firstResult.matched,
  });
  const retry = await client.createPaymentPayload(firstRequired);
  assert.equal(json(retry), json(first), "lost-response retry changed the signed payload");
  const retryResult = await execute(retry, firstRequirements, false);
  assert.equal(applicationExecutions, 1, "replay executed the application twice");
  assert.equal((await serverStore.get(channelId)).chargedCumulativeAmount, 1_000n);
  await clientScheme.schemeHooks.onPaymentResponse({
    paymentPayload: retry,
    requirements: retryResult.matched,
    settleResponse: retryResult.settled,
  });

  const pay = async expectedType => {
    const requiredResponse = await paymentRequired();
    const requirements = requiredResponse.accepts.find(item => item.scheme === "batch-settlement");
    assert(requirements);
    const payload = await client.createPaymentPayload(requiredResponse);
    assert.equal(payload.payload.type, expectedType);
    const result = await execute(payload, requirements);
    await clientScheme.schemeHooks.onPaymentResponse({
      paymentPayload: payload,
      requirements: result.matched,
      settleResponse: result.settled,
    });
    return { payload, requirements, result };
  };

  phase = "local_voucher";
  const verifyAfterOpenRetry = facilitator.calls.verify.length;
  const settleAfterOpenRetry = facilitator.calls.settle.length;
  await pay("voucher");
  assert.equal(facilitator.calls.verify.length, verifyAfterOpenRetry, "voucher called /verify");
  assert.equal(facilitator.calls.settle.length, settleAfterOpenRetry, "voucher called /settle");

  phase = "sdk_restarts";
  // Recreate both SDK components from their durable stores independently.
  restartClient();
  await restartServer();
  await pay("voucher");
  assert.equal((await serverStore.get(channelId)).chargedCumulativeAmount, 3_000n);
  phase = "deployment_restart_window";
  console.log("E2E_RESTART_WINDOW_READY", json({ channelId, charged: "3000" }));
  await sleep(RESTART_PAUSE_MS);
  console.log("E2E_RESTART_WINDOW_COMPLETE");

  phase = "top_up_and_concurrency";
  // The second create must queue until the first response advances the channel.
  const fourthRequired = await paymentRequired();
  const fourthRequirements = fourthRequired.accepts.find(
    item => item.scheme === "batch-settlement",
  );
  assert(fourthRequirements);
  const fourth = await client.createPaymentPayload(fourthRequired);
  assert.equal(fourth.payload.type, "deposit", "fourth payment should top up");
  const fifthRequired = await paymentRequired();
  const fifthRequirements = fifthRequired.accepts.find(item => item.scheme === "batch-settlement");
  assert(fifthRequirements);
  let fifthResolved = false;
  const fifthPromise = client.createPaymentPayload(fifthRequired).then(value => {
    fifthResolved = true;
    return value;
  });
  await sleep(250);
  assert.equal(fifthResolved, false, "concurrent authorization was not serialized");
  const fourthResult = await execute(fourth, fourthRequirements);
  await clientScheme.schemeHooks.onPaymentResponse({
    paymentPayload: fourth,
    requirements: fourthResult.matched,
    settleResponse: fourthResult.settled,
  });
  const fifth = await fifthPromise;
  assert.equal(fifth.payload.type, "voucher");
  assert.equal(fifth.payload.voucher.maxClaimableAmount, "5000");
  const fifthResult = await execute(fifth, fifthRequirements);
  await clientScheme.schemeHooks.onPaymentResponse({
    paymentPayload: fifth,
    requirements: fifthResult.matched,
    settleResponse: fifthResult.settled,
  });

  const afterTopUp = await channelSnapshot(channelId);
  assert(afterTopUp);
  assert.equal(afterTopUp.channel.deposit, 6_000n);
  assert.equal((await serverStore.get(channelId)).chargedCumulativeAmount, 5_000n);

  phase = "claim_and_distribute";
  // Two worker instances contend for the same lease. Exactly one redeems.
  const managerConfig = {
    store: serverStore,
    requirements: fifthRequirements,
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
  };
  const managers = [new BatchChannelManager(managerConfig), new BatchChannelManager(managerConfig)];
  const redemption = await Promise.all(managers.map(manager => manager.redeem()));
  assert.equal(redemption.flatMap(item => item.claimed).length, 1);
  assert.equal(redemption.flatMap(item => item.distributed).length, 1);
  assert.deepEqual(await managers[0].redeem(), { claimed: [], distributed: [] });

  const redeemed = await channelSnapshot(channelId);
  assert(redeemed);
  assert.equal(redeemed.channel.deposit, 6_000n);
  assert.equal(redeemed.channel.settlement.settled, 5_000n);
  assert.equal(redeemed.channel.settlement.payoutWatermark, 5_000n);
  assert.equal(await usdcBalance(receiverSigner.address), before.receiverUsdc + 5_000n);

  phase = "request_close";
  const refundPayload = await clientScheme.createRefundPayload(2, fifthRequirements);
  const refund = { accepted: fifthRequirements, ...refundPayload };
  const refundResult = await execute(refund, fifthRequirements, false);
  assert.equal(refundResult.settled.success, true);
  const closing = await channelSnapshot(channelId);
  assert(closing);
  assert.equal(closing.channel.status, 2);
  assert.equal(closing.channel.gracePeriod, WITHDRAW_DELAY);
  console.log(
    "E2E_CLOSE_CONFIRMED",
    json({ channelId, closureStartedAt: closing.channel.closureStartedAt }),
  );

  phase = "cleanup_wait";
  const waitStarted = Date.now();
  let lastStatus = closing.channel.status;
  while (Date.now() - waitStarted < RECLAIM_TIMEOUT_MS) {
    await sleep(30_000);
    const current = await channelSnapshot(channelId);
    if (!current) break;
    if (current.channel.status !== lastStatus || (Date.now() - waitStarted) % 120_000 < 30_000) {
      lastStatus = current.channel.status;
      console.log(
        "E2E_CLOSE_PROGRESS",
        json({
          elapsedSecs: Math.floor((Date.now() - waitStarted) / 1_000),
          status: current.channel.status,
          settled: current.channel.settlement.settled,
          payoutWatermark: current.channel.settlement.payoutWatermark,
        }),
      );
    }
  }
  assert.equal(
    await accountInfo(channelId),
    null,
    "cleanup worker did not reclaim channel before timeout",
  );

  const after = {
    clientUsdc: await usdcBalance(clientSigner.address),
    receiverUsdc: await usdcBalance(receiverSigner.address),
    feePayerSol: await solBalance(EXPECTED_FEE_PAYER),
    feePayerUsdc: await usdcBalance(EXPECTED_FEE_PAYER),
  };
  assert.equal(after.clientUsdc, 45_000n);
  assert.equal(after.receiverUsdc, before.receiverUsdc + 5_000n);
  assert.equal(after.feePayerSol <= before.feePayerSol, true);
  assert.equal(after.feePayerUsdc, before.feePayerUsdc);
  assert.equal((await serverStore.get(channelId)).chargedCumulativeAmount, 5_000n);
  assert.equal(applicationExecutions, 5);

  const httpSummary = Object.fromEntries(
    Object.entries(facilitator.calls).map(([operation, values]) => [
      operation,
      { count: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) },
    ]),
  );
  const rpcSummary = Object.fromEntries(
    [...rpcMetrics.entries()].map(([method, metric]) => [
      method,
      {
        count: metric.count,
        p50Ms: percentile(metric.ms, 0.5),
        p95Ms: percentile(metric.ms, 0.95),
      },
    ]),
  );
  const summary = {
    success: true,
    network: NETWORK,
    channelId,
    requests: 5,
    applicationExecutions,
    deposit: "6000",
    charged: "5000",
    settled: "5000",
    payoutWatermark: "5000",
    clientRefunded: "1000",
    receiverPaid: "5000",
    facilitatorHttp: httpSummary,
    observedRpc: rpcSummary,
    feePayerLamportsSpent: (before.feePayerSol - after.feePayerSol).toString(),
  };
  phase = "complete";
  reportTermination(summary);
  console.log("E2E_RESULT", json(summary));
}

main().catch(error => {
  const code =
    error?.code === "ERR_ASSERTION"
      ? "assertion_failed"
      : error instanceof TypeError
        ? "type_error"
        : error instanceof RangeError
          ? "range_error"
          : "runtime_error";
  reportTermination({ success: false, phase, code });
  console.error("E2E_FAILURE", json({ success: false, phase, code }));
  process.exitCode = 1;
});
