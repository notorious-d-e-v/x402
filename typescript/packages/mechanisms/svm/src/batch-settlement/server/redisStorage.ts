/* eslint-disable jsdoc/require-jsdoc */
import type { ChannelState, ChannelStore } from "./storage";

const DEFAULT_KEY_PREFIX = "x402:batch-settlement:svm";
const DEFAULT_SCAN_COUNT = 100;
const DEFAULT_RETRY_MS = 10;

const COMPARE_AND_SET = `
local current = redis.call("GET", KEYS[1])
if ARGV[1] == "0" then
  if current ~= false then return 0 end
elseif current ~= ARGV[2] then
  return 0
end
redis.call("SET", KEYS[1], ARGV[3])
return 1
`;

const RENEW_LEASE = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call("PEXPIRE", KEYS[1], ARGV[2])
`;

const RELEASE_LEASE = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call("DEL", KEYS[1])
`;

export type RedisEvalOptions = { keys: string[]; arguments: string[] };
export type RedisSetOptions = { NX?: true; PX?: number };
export type RedisScanOptions = { MATCH?: string; COUNT?: number };

/** Minimal structural Redis client accepted by {@link RedisChannelStore}. */
export interface RedisChannelStoreClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<string | null>;
  eval(script: string, options: RedisEvalOptions): Promise<unknown>;
  scanIterator(options: RedisScanOptions): AsyncIterable<string | string[]>;
}

export interface RedisChannelStoreOptions {
  client: RedisChannelStoreClient;
  keyPrefix?: string;
  retryIntervalMs?: number;
  scanCount?: number;
}

/**
 * Durable, cross-process SVM channel storage.
 *
 * Channel updates use optimistic compare-and-set. Worker leases are token
 * bound, automatically renewed, and released only by their owner.
 */
export class RedisChannelStore implements ChannelStore {
  readonly durable = true;
  private readonly client: RedisChannelStoreClient;
  private readonly channelPrefix: string;
  private readonly leasePrefix: string;
  private readonly retryIntervalMs: number;
  private readonly scanCount: number;

  constructor(options: RedisChannelStoreOptions) {
    this.client = options.client;
    const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.channelPrefix = `${prefix}:server:channel`;
    this.leasePrefix = `${prefix}:server:lease`;
    this.retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_MS;
    this.scanCount = options.scanCount ?? DEFAULT_SCAN_COUNT;
  }

  async get(channelId: string): Promise<ChannelState | undefined> {
    const value = await this.client.get(this.channelKey(channelId));
    return value === null ? undefined : deserialize(value);
  }

  async list(): Promise<ChannelState[]> {
    const channels: ChannelState[] = [];
    for await (const entry of this.client.scanIterator({
      MATCH: `${this.channelPrefix}:*`,
      COUNT: this.scanCount,
    })) {
      for (const key of Array.isArray(entry) ? entry : [entry]) {
        const value = await this.client.get(key);
        if (value !== null) channels.push(deserialize(value));
      }
    }
    return channels.sort((a, b) => a.channelId.localeCompare(b.channelId));
  }

  async put(state: ChannelState): Promise<void> {
    await this.client.set(this.channelKey(state.channelId), serialize(state));
  }

  async update(
    channelId: string,
    updater: (current: ChannelState | undefined) => ChannelState | Promise<ChannelState>,
  ): Promise<ChannelState> {
    const key = this.channelKey(channelId);
    for (;;) {
      const currentRaw = await this.client.get(key);
      const next = await updater(currentRaw === null ? undefined : deserialize(currentRaw));
      if (next.channelId !== channelId) {
        throw new Error("ChannelStore updater cannot change channelId");
      }
      const applied = await this.client.eval(COMPARE_AND_SET, {
        keys: [key],
        arguments: [currentRaw === null ? "0" : "1", currentRaw ?? "", serialize(next)],
      });
      if (Number(applied) === 1) return next;
      await sleep(this.retryIntervalMs);
    }
  }

  async acquireLease(key: string, ttlMs: number): Promise<(() => Promise<void>) | undefined> {
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000) {
      throw new Error("lease ttlMs must be an integer of at least 1000");
    }
    const leaseKey = `${this.leasePrefix}:${encodeURIComponent(key)}`;
    const token = createLeaseToken();
    const acquired = await this.client.set(leaseKey, token, { NX: true, PX: ttlMs });
    if (acquired !== "OK") return undefined;

    let released = false;
    const renewal = setInterval(
      () => {
        if (released) return;
        void this.client
          .eval(RENEW_LEASE, {
            keys: [leaseKey],
            arguments: [token, String(ttlMs)],
          })
          .catch(() => undefined);
      },
      Math.max(500, Math.floor(ttlMs / 3)),
    );

    return async () => {
      if (released) return;
      released = true;
      clearInterval(renewal);
      await this.client.eval(RELEASE_LEASE, {
        keys: [leaseKey],
        arguments: [token],
      });
    };
  }

  private channelKey(channelId: string): string {
    return `${this.channelPrefix}:${encodeURIComponent(channelId)}`;
  }
}

function serialize(state: ChannelState): string {
  return JSON.stringify(state, (_key, value: unknown) =>
    typeof value === "bigint" ? { $bigint: value.toString() } : value,
  );
}

function deserialize(value: string): ChannelState {
  return JSON.parse(value, (_key, entry: unknown) => {
    if (
      entry !== null &&
      typeof entry === "object" &&
      Object.keys(entry).length === 1 &&
      "$bigint" in entry &&
      typeof entry.$bigint === "string"
    ) {
      return BigInt(entry.$bigint);
    }
    return entry;
  }) as ChannelState;
}

function createLeaseToken(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now()}:${Math.random().toString(36).slice(2)}:${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
