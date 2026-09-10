import { describe, expect, it } from "vitest";

import {
  RedisChannelStore,
  type RedisChannelStoreClient,
  type RedisEvalOptions,
  type RedisScanOptions,
  type RedisSetOptions,
} from "../../src/batch-settlement/server/redisStorage";
import type { BatchOperation } from "../../src/batch-settlement/server/operationStore";
import type { ChannelState } from "../../src/batch-settlement/server/storage";

type Entry = { value: string; expiresAt?: number };

class FakeRedis implements RedisChannelStoreClient {
  readonly values = new Map<string, Entry>();
  conflicts = 0;

  async get(key: string): Promise<string | null> {
    this.expire(key);
    return this.values.get(key)?.value ?? null;
  }

  async set(key: string, value: string, options?: RedisSetOptions): Promise<string | null> {
    this.expire(key);
    if (options?.NX && this.values.has(key)) return null;
    this.values.set(key, {
      value,
      ...(options?.PX ? { expiresAt: Date.now() + options.PX } : {}),
    });
    return "OK";
  }

  async eval(script: string, options: RedisEvalOptions): Promise<unknown> {
    const key = options.keys[0]!;
    this.expire(key);
    const current = this.values.get(key);
    if (script.includes("ARGV[5]")) {
      const operationKey = options.keys[1]!;
      this.expire(operationKey);
      const operation = this.values.get(operationKey);
      const [expectedExists, expectedChannel, expectedOperation, nextChannel, nextOperation] =
        options.arguments;
      const channelMatches = expectedExists === "0" ? !current : current?.value === expectedChannel;
      if (!channelMatches || operation?.value !== expectedOperation) {
        this.conflicts += 1;
        return 0;
      }
      this.values.set(key, { value: nextChannel! });
      this.values.set(operationKey, { value: nextOperation! });
      return 1;
    }
    if (script.includes("ARGV[3]")) {
      const [expectedExists, expected, next] = options.arguments;
      const matches = expectedExists === "0" ? !current : current?.value === expected;
      if (!matches) {
        this.conflicts += 1;
        return 0;
      }
      this.values.set(key, { value: next! });
      return 1;
    }
    if (script.includes("PEXPIRE")) {
      if (current?.value !== options.arguments[0]) return 0;
      current.expiresAt = Date.now() + Number(options.arguments[1]);
      return 1;
    }
    if (script.includes("DEL")) {
      if (current?.value !== options.arguments[0]) return 0;
      this.values.delete(key);
      return 1;
    }
    throw new Error("unsupported script");
  }

  async *scanIterator(options: RedisScanOptions): AsyncIterable<string[]> {
    const prefix = options.MATCH?.replace(/\*$/, "") ?? "";
    yield [...this.values.keys()].filter(key => key.startsWith(prefix));
  }

  private expire(key: string): void {
    const entry = this.values.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) this.values.delete(key);
  }
}

const state = (channelId: string, charged = 0n): ChannelState => ({
  channelConfig: {
    openSlot: 1,
    payer: "payer",
    payerAuthorizer: "authorizer",
    receiver: "receiver",
    salt: "2",
    token: "mint",
    withdrawDelay: 900,
  },
  channelId,
  chargedCumulativeAmount: charged,
  deposit: 10_000n,
  feePayer: "fee-payer",
  mint: "mint",
  openSlot: 1n,
  payer: "payer",
  payerAuthorizer: "authorizer",
  payoutWatermark: 0n,
  receiver: "receiver",
  salt: 2n,
  settled: 0n,
  signedMaxClaimable: charged,
  status: "open",
  tokenProgram: "token-program",
  withdrawDelay: 900,
});

describe("RedisChannelStore", () => {
  it("round-trips bigint state and lists deterministically", async () => {
    const client = new FakeRedis();
    const store = new RedisChannelStore({ client, keyPrefix: "test" });
    await store.put(state("z", 4n));
    await store.put(state("a", 3n));

    expect((await store.get("z"))?.chargedCumulativeAmount).toBe(4n);
    expect((await store.list()).map(channel => channel.channelId)).toEqual(["a", "z"]);
    expect(store.durable).toBe(true);
  });

  it("serializes concurrent updates with compare-and-set", async () => {
    const client = new FakeRedis();
    const first = new RedisChannelStore({ client, keyPrefix: "test", retryIntervalMs: 1 });
    const second = new RedisChannelStore({ client, keyPrefix: "test", retryIntervalMs: 1 });
    await first.put(state("channel"));

    await Promise.all([
      first.update("channel", async current => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return state("channel", current!.chargedCumulativeAmount + 1n);
      }),
      second.update("channel", current => state("channel", current!.chargedCumulativeAmount + 1n)),
    ]);

    expect((await first.get("channel"))?.chargedCumulativeAmount).toBe(2n);
    expect(client.conflicts).toBeGreaterThan(0);
  });

  it("atomically serializes concurrent channel and operation commits", async () => {
    const client = new FakeRedis();
    const first = new RedisChannelStore({ client, keyPrefix: "test", retryIntervalMs: 1 });
    const second = new RedisChannelStore({ client, keyPrefix: "test", retryIntervalMs: 1 });
    await first.put({
      ...state("channel"),
      reservations: {
        first: {
          ceiling: 1n,
          expiresAt: Date.now() + 10_000,
          idempotencyKey: "first",
          kind: "server",
        },
        second: {
          ceiling: 1n,
          expiresAt: Date.now() + 10_000,
          idempotencyKey: "second",
          kind: "server",
        },
      },
    });
    await first.reserve("channel", "first", 1n, Date.now() + 10_000);
    await second.reserve("channel", "second", 1n, Date.now() + 10_000);

    const commit = async (store: RedisChannelStore, id: string, delay: number) =>
      store.commitWithChannel("channel", id, async (current, reservation) => {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        const cumulative = current!.chargedCumulativeAmount + 1n;
        const channel = {
          ...current!,
          chargedCumulativeAmount: cumulative,
          signedMaxClaimable: cumulative,
          reservations: Object.fromEntries(
            Object.entries(current!.reservations ?? {}).filter(
              ([, value]) => value.idempotencyKey !== id,
            ),
          ),
        };
        const operation: Extract<BatchOperation, { status: "completed" }> = {
          status: "completed",
          channelId: "channel",
          idempotencyKey: id,
          ceiling: reservation.ceiling,
          actual: 1n,
          cumulative,
          receipt: {
            type: "receipt",
            authorizedAmount: "1",
            chargedAmount: "1",
            channelId: "channel",
            cumulativeAmount: cumulative.toString(),
            idempotencyKey: id,
            priorCumulativeAmount: (cumulative - 1n).toString(),
            signature: "signature",
            voucher: {
              channelId: "channel",
              expiresAt: 0,
              maxClaimableAmount: cumulative.toString(),
              signature: "signature",
            },
          },
          response: { success: true, transaction: "", network: "solana:devnet" },
        };
        return { channel, operation };
      });

    await Promise.all([commit(first, "first", 5), commit(second, "second", 0)]);

    expect((await first.get("channel"))?.chargedCumulativeAmount).toBe(2n);
    expect((await first.get("channel", "first"))?.status).toBe("completed");
    expect((await first.get("channel", "second"))?.status).toBe("completed");
    expect(client.conflicts).toBeGreaterThan(0);
  });

  it("allows only one cross-process lease owner and uses token-bound release", async () => {
    const client = new FakeRedis();
    const first = new RedisChannelStore({ client, keyPrefix: "test" });
    const second = new RedisChannelStore({ client, keyPrefix: "test" });

    const release = await first.acquireLease("worker", 1_000);
    expect(release).toBeTypeOf("function");
    expect(await second.acquireLease("worker", 1_000)).toBeUndefined();
    await release!();
    const secondRelease = await second.acquireLease("worker", 1_000);
    expect(secondRelease).toBeTypeOf("function");
    await secondRelease!();
  });
});
