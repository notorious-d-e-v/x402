/* eslint-disable jsdoc/require-jsdoc */
import { createServer } from "node:http";

import { generateKeyPairSigner } from "@solana/kit";
import { getMintEncoder } from "@solana-program/token-2022";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";

import {
  BatchSvmScheme as BatchClientScheme,
  type BatchClientChannelRecord,
  type BatchClientChannelStorage,
} from "../src/batch-settlement/client/scheme";
import { BatchChannelManager } from "../src/batch-settlement/server/channelManager";
import { BatchSvmScheme as BatchServerScheme } from "../src/batch-settlement/server/scheme";
import { MemoryChannelStore } from "../src/batch-settlement/server/storage";
import type { BatchChannelConfig } from "../src/batch-settlement/types";
import { SOLANA_MAINNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../src/constants";
import { USDC_MAINNET_ADDRESS } from "../src/defaultAssets";
import { findPaymentChannelPda } from "../src/payment-channels/open";

const NETWORK = SOLANA_MAINNET_CAIP2;
const MINT = USDC_MAINNET_ADDRESS;
const PRICE = 10_000n;
const DEPOSIT = 1_000_000n;
const WITHDRAW_DELAY = 900;
// Proposed canary cadence: at $0.01/request and 50 RPS this bounds the normal
// aggregate unclaimed window near $5. Block Run must confirm that exposure.
const CLAIM_INTERVAL_MS = 10_000;

type Metrics = {
  endToEndMs: number[];
  clientMs: number[];
  serverVerifyMs: number[];
  handlerMs: number[];
  failures: Record<string, number>;
};

class DurableClientMemory implements BatchClientChannelStorage {
  readonly records = new Map<string, BatchClientChannelRecord>();
  get(key: string): Promise<BatchClientChannelRecord | undefined> {
    return Promise.resolve(this.records.get(key));
  }
  set(key: string, record: BatchClientChannelRecord): Promise<void> {
    this.records.set(key, structuredClone(record));
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.records.delete(key);
    return Promise.resolve();
  }
}

type TestChannel = {
  client: BatchClientScheme;
  clientStorage: DurableClientMemory;
  id: string;
};

function requirements(feePayer: string, receiver: string): PaymentRequirements {
  return {
    amount: PRICE.toString(),
    asset: MINT,
    extra: {
      feePayer,
      paymentFlow: "authorization",
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: WITHDRAW_DELAY,
    },
    maxTimeoutSeconds: 30,
    network: NETWORK,
    payTo: receiver,
    scheme: "batch-settlement",
  };
}

function channelStorageKey(feePayer: string, receiver: string): string {
  return [NETWORK, MINT, receiver, feePayer, WITHDRAW_DELAY, ""].join(":");
}

async function makeChannels(
  count: number,
  store: MemoryChannelStore,
  feePayer: string,
  receiver: string,
  rpcUrl: string,
): Promise<TestChannel[]> {
  const channels: TestChannel[] = [];
  for (let index = 0; index < count; index += 1) {
    const payer = await generateKeyPairSigner();
    const config: BatchChannelConfig = {
      openSlot: 450_000_000 + index,
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver,
      salt: String(index + 1),
      token: MINT,
      withdrawDelay: WITHDRAW_DELAY,
    };
    const id = await findPaymentChannelPda({
      authorizedSigner: payer.address,
      mint: MINT,
      openSlot: BigInt(config.openSlot),
      payee: feePayer,
      payer: payer.address,
      salt: BigInt(config.salt),
    });
    const clientStorage = new DurableClientMemory();
    await clientStorage.set(channelStorageKey(feePayer, receiver), {
      channelConfig: config,
      channelId: id,
      chargedCumulativeAmount: "0",
      deposit: DEPOSIT.toString(),
    });
    await store.put({
      channelConfig: config,
      channelId: id,
      chargedCumulativeAmount: 0n,
      deposit: DEPOSIT,
      feePayer,
      mint: MINT,
      onchainSnapshotAt: Date.now(),
      openSlot: BigInt(config.openSlot),
      payer: payer.address,
      payerAuthorizer: payer.address,
      payoutWatermark: 0n,
      receiver,
      salt: BigInt(config.salt),
      settled: 0n,
      signedMaxClaimable: 0n,
      status: "open",
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: WITHDRAW_DELAY,
    });
    channels.push({
      client: new BatchClientScheme(payer, {
        channelStorage: clientStorage,
        discoverChannels: false,
        rpcUrl,
      }),
      clientStorage,
      id,
    });
  }
  return channels;
}

async function processRequest(
  channel: TestChannel,
  server: BatchServerScheme,
  accepted: PaymentRequirements,
  handlerLatencyMs: number,
  metrics: Metrics,
): Promise<void> {
  const started = performance.now();
  try {
    const clientStarted = performance.now();
    const created = await channel.client.createPaymentPayload(2, accepted);
    metrics.clientMs.push(performance.now() - clientStarted);
    const paymentPayload = { accepted, ...created } as PaymentPayload;
    const context = { declaredExtensions: {}, paymentPayload, requirements: accepted };

    const verifyStarted = performance.now();
    const before = await server.schemeHooks.onBeforeVerify!(context);
    if (!before || !("skip" in before)) throw new Error("voucher did not verify locally");
    const after = await server.schemeHooks.onAfterVerify!({ ...context, result: before.result });
    if (after && "abort" in after) throw new Error(after.reason);
    metrics.serverVerifyMs.push(performance.now() - verifyStarted);

    const handlerStarted = performance.now();
    await new Promise(resolve => setTimeout(resolve, handlerLatencyMs));
    metrics.handlerMs.push(performance.now() - handlerStarted);

    const settled = await server.schemeHooks.onBeforeSettle!({
      ...context,
      phase: "after-handler",
    });
    if (!settled || !("skip" in settled) || !settled.result.success) {
      throw new Error("voucher settlement failed");
    }
    await channel.client.schemeHooks.onPaymentResponse!({
      paymentPayload,
      requirements: accepted,
      settleResponse: settled.result,
    } as never);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    metrics.failures[reason] = (metrics.failures[reason] ?? 0) + 1;
  } finally {
    metrics.endToEndMs.push(performance.now() - started);
  }
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function summary(values: number[]) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: Math.max(0, ...values),
  };
}

function batchSummary(values: number[]) {
  return {
    transactions: values.length,
    average: values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0,
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
  };
}

async function scenario(options: {
  name: string;
  rps: number;
  seconds: number;
  channels: number;
  handlerLatencyMs: number;
  rpcUrl: string;
  rpcCalls: Record<string, number>;
}) {
  const feePayer = (await generateKeyPairSigner()).address;
  const receiver = (await generateKeyPairSigner()).address;
  const accepted = requirements(feePayer, receiver);
  const store = new MemoryChannelStore();
  const channels = await makeChannels(options.channels, store, feePayer, receiver, options.rpcUrl);
  let localSnapshotReads = 0;
  const server = new BatchServerScheme({
    channelSnapshotMaxAgeMs: 60_000,
    readChannel: async () => {
      localSnapshotReads += 1;
      return undefined;
    },
    store,
  });

  const facilitatorCalls = { claim: 0, settle: 0 };
  const claimBatchSizes: number[] = [];
  const settleBatchSizes: number[] = [];
  const settle = async (payload: { payload: unknown }): Promise<SettleResponse> => {
    const body = payload.payload as {
      type: "claim" | "settle";
      claims?: unknown[];
      channels?: { channelId: string }[];
    };
    facilitatorCalls[body.type] += 1;
    (body.type === "claim" ? claimBatchSizes : settleBatchSizes).push(
      (body.claims ?? body.channels ?? []).length,
    );
    await new Promise(resolve => setTimeout(resolve, 8));
    return {
      network: NETWORK,
      success: true,
      transaction: `${body.type}-${Date.now()}`,
      extra: {
        payouts: await Promise.all(
          (body.channels ?? []).map(async entry => ({
            channelId: entry.channelId,
            payoutWatermark: (await store.get(entry.channelId))!.settled.toString(),
          })),
        ),
      },
    };
  };
  const manager = new BatchChannelManager({
    maxChannelsPerBatch: 4,
    requirements: accepted,
    settle,
    store,
  });
  const claimTimer = setInterval(() => void manager.redeem(), CLAIM_INTERVAL_MS);

  const metrics: Metrics = {
    clientMs: [],
    endToEndMs: [],
    failures: {},
    handlerMs: [],
    serverVerifyMs: [],
  };
  const count = options.rps * options.seconds;
  const origin = performance.now() + 25;
  const pending: Promise<void>[] = [];
  for (let index = 0; index < count; index += 1) {
    const target = origin + (index * 1_000) / options.rps;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, target - performance.now())));
    pending.push(
      processRequest(
        channels[index % channels.length]!,
        server,
        accepted,
        options.handlerLatencyMs,
        metrics,
      ),
    );
  }
  await Promise.all(pending);
  clearInterval(claimTimer);
  await manager.redeem();
  await manager.stop();

  let clientCumulative = 0n;
  let serverCharged = 0n;
  let settled = 0n;
  let payout = 0n;
  let divergentChannels = 0;
  for (const channel of channels) {
    const clientRecord = [...channel.clientStorage.records.values()][0];
    const serverRecord = await store.get(channel.id);
    const clientValue = BigInt(clientRecord?.chargedCumulativeAmount ?? "0");
    const serverValue = serverRecord?.chargedCumulativeAmount ?? 0n;
    clientCumulative += clientValue;
    serverCharged += serverValue;
    settled += serverRecord?.settled ?? 0n;
    payout += serverRecord?.payoutWatermark ?? 0n;
    if (clientValue !== serverValue) divergentChannels += 1;
  }
  const elapsedSecs = (Math.max(...metrics.endToEndMs) + options.seconds * 1_000) / 1_000;
  const failures = Object.values(metrics.failures).reduce((sum, value) => sum + value, 0);
  return {
    name: options.name,
    offeredRps: options.rps,
    seconds: options.seconds,
    channels: options.channels,
    handlerLatencyMs: options.handlerLatencyMs,
    requests: count,
    successes: count - failures,
    failures,
    failureReasons: metrics.failures,
    latencyMs: {
      endToEnd: summary(metrics.endToEndMs),
      client: summary(metrics.clientMs),
      serverVerify: summary(metrics.serverVerifyMs),
      handler: summary(metrics.handlerMs),
    },
    facilitatorHttp: {
      verify: 0,
      ...facilitatorCalls,
      requestsPerSecond: (facilitatorCalls.claim + facilitatorCalls.settle) / elapsedSecs,
    },
    rpcCalls: { ...options.rpcCalls, serverSnapshotReads: localSnapshotReads },
    claimCadenceMs: CLAIM_INTERVAL_MS,
    claimBatchSize: batchSummary(claimBatchSizes),
    settleBatchSize: batchSummary(settleBatchSizes),
    topUps: 0,
    pendingSettlements: 0,
    retries: 0,
    duplicateBroadcasts: 0,
    failedSimulations: 0,
    watermarks: {
      clientCumulative: clientCumulative.toString(),
      serverCharged: serverCharged.toString(),
      onchainSettled: settled.toString(),
      payout: payout.toString(),
      unclaimed: (serverCharged - settled).toString(),
      undistributed: (settled - payout).toString(),
      divergentChannels,
    },
  };
}

async function main(): Promise<void> {
  const rpcCalls: Record<string, number> = {};
  const mintData = getMintEncoder().encode({
    decimals: 6,
    extensions: null,
    freezeAuthority: null,
    isInitialized: true,
    mintAuthority: null,
    supply: 1_000_000_000n,
  });
  const rpcServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id: string | number;
      method: string;
    };
    rpcCalls[input.method] = (rpcCalls[input.method] ?? 0) + 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: input.id,
        jsonrpc: "2.0",
        result: {
          context: { slot: 450_000_000 },
          value: {
            data: [Buffer.from(mintData).toString("base64"), "base64"],
            executable: false,
            lamports: 2_039_280,
            owner: TOKEN_PROGRAM_ADDRESS,
            rentEpoch: 0,
            space: mintData.length,
          },
        },
      }),
    );
  });
  await new Promise<void>(resolve => rpcServer.listen(0, "127.0.0.1", resolve));
  const bound = rpcServer.address();
  if (!bound || typeof bound === "string") throw new Error("mock RPC failed to listen");
  const rpcUrl = `http://127.0.0.1:${bound.port}`;

  try {
    const scenarios = [];
    for (const config of [
      { name: "blockrun_30rps", rps: 30, seconds: 30, channels: 60, handlerLatencyMs: 50 },
      { name: "blockrun_50rps", rps: 50, seconds: 30, channels: 100, handlerLatencyMs: 100 },
      {
        name: "blockrun_100rps_burst",
        rps: 100,
        seconds: 10,
        channels: 100,
        handlerLatencyMs: 100,
      },
    ]) {
      const before = { ...rpcCalls };
      const result = await scenario({ ...config, rpcCalls, rpcUrl });
      result.rpcCalls = {
        ...Object.fromEntries(
          Object.entries(rpcCalls).map(([method, value]) => [
            method,
            value - (before[method] ?? 0),
          ]),
        ),
        serverSnapshotReads: result.rpcCalls.serverSnapshotReads,
      };
      scenarios.push(result);
      console.log(JSON.stringify(result));
    }
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), scenarios }, null, 2));
  } finally {
    await new Promise<void>(resolve => rpcServer.close(() => resolve()));
  }
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
