/* eslint-disable jsdoc/require-jsdoc */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import {
  generateKeyPairSigner,
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { getMintEncoder } from "@solana-program/token-2022";
import { base58 } from "@scure/base";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import { signBatchVoucher } from "../src/batch-settlement/client/channel";
import { BatchSvmScheme } from "../src/batch-settlement/facilitator/scheme";
import type { BatchChannelConfig, BatchFacilitatorPayload } from "../src/batch-settlement/types";
import { SOLANA_MAINNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../src/constants";
import { USDC_MAINNET_ADDRESS } from "../src/defaultAssets";
import {
  getChannelEncoder,
  type ChannelArgs,
} from "../src/payment-channels/generated/accounts/channel";
import { AccountDiscriminator } from "../src/payment-channels/generated/types/accountDiscriminator";
import { ChannelStatus } from "../src/payment-channels/generated/types/channelStatus";
import { getChannelDistributionHash } from "../src/payment-channels/facilitator";
import { PAYMENT_CHANNELS_PROGRAM_ID } from "../src/payment-channels/onchain";
import { findPaymentChannelPda } from "../src/payment-channels/open";
import { toFacilitatorSvmSigner } from "../src/signer";

const NETWORK = SOLANA_MAINNET_CAIP2;
const MINT = USDC_MAINNET_ADDRESS;
const RPC_DELAY_MS = 5;

type Mode = "claim" | "distribute";
type Message = { staticAccounts: readonly string[] };
type Account = ReturnType<typeof account>;

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

function account(data: Uint8Array, owner: string) {
  return {
    data: [Buffer.from(data).toString("base64"), "base64"],
    executable: false,
    lamports: 2_000_000,
    owner,
    rentEpoch: 0,
    space: data.length,
  };
}

async function main(): Promise<void> {
  const payer = await generateKeyPairSigner();
  const facilitatorKeypair = await generateKeyPairSigner();
  const receiver = (await generateKeyPairSigner()).address;
  const channels = new Map<string, ChannelArgs>();
  const sentAt = new Map<string, number>();
  const calls: Record<string, number> = {};
  const mint = account(
    getMintEncoder().encode({
      decimals: 6,
      extensions: null,
      freezeAuthority: null,
      isInitialized: true,
      mintAuthority: null,
      supply: 1_000_000_000n,
    }),
    TOKEN_PROGRAM_ADDRESS,
  );
  let mode: Mode = "claim";
  let confirmationDelayMs = 0;
  let activeRpc = 0;
  let maxActiveRpc = 0;

  const readAccount = (key: string): Account | null => {
    if (key === MINT) return mint;
    const channel = channels.get(key);
    return channel
      ? account(getChannelEncoder().encode(channel), PAYMENT_CHANNELS_PROGRAM_ID)
      : null;
  };

  const rpcResult = (method: string, params: unknown[]): unknown => {
    if (method === "getAccountInfo") {
      return { context: { slot: 450_000_000 }, value: readAccount(String(params[0])) };
    }
    if (method === "getMultipleAccounts") {
      return {
        context: { slot: 450_000_000 },
        value: (params[0] as string[]).map(readAccount),
      };
    }
    if (method === "getLatestBlockhash") {
      return {
        context: { slot: 450_000_000 },
        value: { blockhash: MINT, lastValidBlockHeight: 999_999_999 },
      };
    }
    if (method === "simulateTransaction") {
      return {
        context: { slot: 450_000_000 },
        value: { accounts: null, err: null, logs: [], returnData: null, unitsConsumed: 250_000 },
      };
    }
    if (method === "sendTransaction") {
      const transaction = getTransactionDecoder().decode(
        getBase64Codec().encode(String(params[0])),
      );
      const message = getCompiledTransactionMessageDecoder().decode(
        transaction.messageBytes,
      ) as unknown as Message;
      for (const key of message.staticAccounts) {
        const channel = channels.get(key);
        if (!channel) continue;
        channel.settlement =
          mode === "claim"
            ? { ...channel.settlement, settled: 1n }
            : { ...channel.settlement, payoutWatermark: channel.settlement.settled };
      }
      const signature = base58.encode(randomBytes(64));
      sentAt.set(signature, Date.now());
      return signature;
    }
    if (method === "getSignatureStatuses") {
      return {
        context: { slot: 450_000_001 },
        value: (params[0] as string[]).map(signature => {
          const confirmed = Date.now() - (sentAt.get(signature) ?? 0) >= confirmationDelayMs;
          return {
            confirmationStatus: confirmed ? "confirmed" : "processed",
            confirmations: confirmed ? null : 1,
            err: null,
            slot: 450_000_001,
            status: { Ok: null },
          };
        }),
      };
    }
    throw new Error(`unsupported RPC method ${method}`);
  };

  const rpcServer = createServer(async (request, response) => {
    activeRpc += 1;
    maxActiveRpc = Math.max(maxActiveRpc, activeRpc);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const batch = Array.isArray(requestBody) ? requestBody : [requestBody];
      const replies = batch.map(entry => {
        calls[entry.method] = (calls[entry.method] ?? 0) + 1;
        try {
          return {
            id: entry.id,
            jsonrpc: "2.0",
            result: rpcResult(entry.method, entry.params ?? []),
          };
        } catch (error) {
          return {
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
            id: entry.id,
            jsonrpc: "2.0",
          };
        }
      });
      await new Promise(resolve => setTimeout(resolve, RPC_DELAY_MS));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(Array.isArray(requestBody) ? replies : replies[0]));
    } finally {
      activeRpc -= 1;
    }
  });
  await new Promise<void>(resolve => rpcServer.listen(0, "127.0.0.1", resolve));
  const bound = rpcServer.address();
  if (!bound || typeof bound === "string") throw new Error("mock RPC did not bind");
  const rpcUrl = `http://127.0.0.1:${bound.port}`;
  const signer = toFacilitatorSvmSigner(facilitatorKeypair, { defaultRpcUrl: rpcUrl });
  const scheme = new BatchSvmScheme(signer, { rpcUrl });

  const requirements = (): PaymentRequirements => ({
    amount: "1",
    asset: MINT,
    extra: {
      feePayer: facilitatorKeypair.address,
      paymentFlow: "authorization",
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    },
    maxTimeoutSeconds: 30,
    network: NETWORK,
    payTo: receiver,
    scheme: "batch-settlement",
  });
  const payment = (payload: BatchFacilitatorPayload): PaymentPayload => ({
    accepted: requirements(),
    payload,
    x402Version: 2,
  });

  let sequence = 0;
  const makeChannel = async (settled: bigint) => {
    sequence += 1;
    const config: BatchChannelConfig = {
      openSlot: 449_000_000 + sequence,
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver,
      salt: String(sequence),
      token: MINT,
      withdrawDelay: 900,
    };
    const id = await findPaymentChannelPda({
      authorizedSigner: payer.address,
      mint: MINT,
      openSlot: BigInt(config.openSlot),
      payee: facilitatorKeypair.address,
      payer: payer.address,
      salt: BigInt(config.salt),
    });
    channels.set(id, {
      authorizedSigner: payer.address,
      bump: 1,
      closureStartedAt: 0n,
      deposit: 100n,
      discriminator: AccountDiscriminator.Channel,
      distributionHash: [...getChannelDistributionHash([{ bps: 10_000, recipient: receiver }])],
      gracePeriod: 900,
      mint: MINT,
      openSlot: BigInt(config.openSlot),
      payee: facilitatorKeypair.address,
      payer: payer.address,
      payerWithdrawnAt: 0n,
      rentPayer: facilitatorKeypair.address,
      salt: BigInt(config.salt),
      settlement: { payoutWatermark: 0n, settled },
      status: ChannelStatus.Open,
      version: 1,
    });
    const voucher = await signBatchVoucher(payer, {
      channelId: id,
      expiresAt: 0,
      maxClaimableAmount: 1n,
    });
    return { config, id, signature: voucher.signature };
  };

  const prepare = async (kind: Mode, count: number): Promise<PaymentPayload[]> => {
    const payloads: PaymentPayload[] = [];
    for (let index = 0; index < count; index += 1) {
      const entries = await Promise.all(
        [0, 1, 2, 3].map(() => makeChannel(kind === "claim" ? 0n : 1n)),
      );
      payloads.push(
        payment(
          kind === "claim"
            ? {
                claims: entries.map(entry => ({
                  signature: entry.signature,
                  voucher: {
                    channelConfig: entry.config,
                    channelId: entry.id,
                    expiresAt: 0,
                    maxClaimableAmount: "1",
                  },
                })),
                type: "claim",
              }
            : {
                channels: entries.map(entry => ({
                  channelConfig: entry.config,
                  channelId: entry.id,
                })),
                type: "settle",
              },
        ),
      );
    }
    return payloads;
  };

  const run = async (kind: Mode, rps: number, seconds: number, confirmMs = 0) => {
    mode = kind;
    confirmationDelayMs = confirmMs;
    for (const key of Object.keys(calls)) delete calls[key];
    maxActiveRpc = 0;
    const count = rps * seconds;
    const payloads = await prepare(kind, count);
    const latencies: number[] = [];
    const outcomes: boolean[] = [];
    const pending: Promise<void>[] = [];
    const origin = performance.now() + 25;
    let activeSettles = 0;
    let maxActiveSettles = 0;
    for (let index = 0; index < count; index += 1) {
      const target = origin + (index * 1_000) / rps;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, target - performance.now())));
      pending.push(
        (async () => {
          const began = performance.now();
          activeSettles += 1;
          maxActiveSettles = Math.max(maxActiveSettles, activeSettles);
          try {
            outcomes.push((await scheme.settle(payloads[index]!, requirements())).success);
          } finally {
            activeSettles -= 1;
            latencies.push(performance.now() - began);
          }
        })(),
      );
    }
    await Promise.all(pending);
    const totalRpc = Object.values(calls).reduce((sum, value) => sum + value, 0);
    const output = {
      channelsPerRequest: 4,
      confirmationDelayMs: confirmMs,
      failures: outcomes.filter(success => !success).length,
      kind,
      latencyMs: {
        max: Math.max(...latencies),
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
      },
      maxConcurrentSettlements: maxActiveSettles,
      requests: count,
      rpc: {
        calls: { ...calls },
        delayMs: RPC_DELAY_MS,
        maxConcurrentHttpRequests: maxActiveRpc,
        perSettleRequest: totalRpc / count,
        total: totalRpc,
      },
      rps,
      seconds,
      successes: outcomes.filter(Boolean).length,
    };
    console.log(JSON.stringify(output));
    return output;
  };

  try {
    const results = [
      await run("claim", 5, 5),
      await run("distribute", 5, 5),
      await run("claim", 30, 3),
      await run("claim", 50, 3),
      await run("claim", 5, 3, 400),
    ];
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  } finally {
    await new Promise<void>(resolve => rpcServer.close(() => resolve()));
  }
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
