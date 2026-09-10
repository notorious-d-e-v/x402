/* eslint-disable jsdoc/require-jsdoc */
import type { BatchOperation, BatchOperationStore } from "./operationStore";
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

const COMPARE_AND_DELETE = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call("DEL", KEYS[1])
`;

const COMMIT_CHANNEL_OPERATION = `
local channel = redis.call("GET", KEYS[1])
local operation = redis.call("GET", KEYS[2])
if ARGV[1] == "0" then
  if channel ~= false then return 0 end
elseif channel ~= ARGV[2] then
  return 0
end
if operation ~= ARGV[3] then return 0 end
redis.call("SET", KEYS[1], ARGV[4])
redis.call("SET", KEYS[2], ARGV[5])
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
export class RedisChannelStore implements ChannelStore, BatchOperationStore {
  readonly durable = true;
  private readonly client: RedisChannelStoreClient;
  private readonly channelPrefix: string;
  private readonly operationPrefix: string;
  private readonly leasePrefix: string;
  private readonly retryIntervalMs: number;
  private readonly scanCount: number;

  constructor(options: RedisChannelStoreOptions) {
    this.client = options.client;
    const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.channelPrefix = `${prefix}:server:channel`;
    this.operationPrefix = `${prefix}:server:operation`;
    this.leasePrefix = `${prefix}:server:lease`;
    this.retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_MS;
    this.scanCount = options.scanCount ?? DEFAULT_SCAN_COUNT;
  }

  get(channelId: string): Promise<ChannelState | undefined>;
  get(channelId: string, idempotencyKey: string): Promise<BatchOperation | undefined>;
  async get(
    channelId: string,
    idempotencyKey?: string,
  ): Promise<ChannelState | BatchOperation | undefined> {
    const key =
      idempotencyKey === undefined
        ? this.channelKey(channelId)
        : this.operationKey(channelId, idempotencyKey);
    const value = await this.client.get(key);
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
        if (value !== null) channels.push(deserialize<ChannelState>(value));
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
      const next = await updater(
        currentRaw === null ? undefined : deserialize<ChannelState>(currentRaw),
      );
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

  async reserve(
    channelId: string,
    idempotencyKey: string,
    ceiling: bigint,
    expiresAt: number,
  ): Promise<{ created: boolean; operation: BatchOperation }> {
    const key = this.operationKey(channelId, idempotencyKey);
    for (;;) {
      const currentRaw = await this.client.get(key);
      const current = currentRaw === null ? undefined : deserialize<BatchOperation>(currentRaw);
      if (current && current.ceiling !== ceiling) {
        throw new Error("batch operation ceiling changed for an idempotency key");
      }
      if (current?.status === "completed" || (current && current.expiresAt > Date.now())) {
        return { created: false, operation: current };
      }
      const operation: BatchOperation = {
        status: "reserved",
        channelId,
        idempotencyKey,
        ceiling,
        expiresAt,
      };
      const applied = await this.client.eval(COMPARE_AND_SET, {
        keys: [key],
        arguments: [currentRaw === null ? "0" : "1", currentRaw ?? "", serialize(operation)],
      });
      if (Number(applied) === 1) return { created: true, operation };
      await sleep(this.retryIntervalMs);
    }
  }

  async complete(operation: Extract<BatchOperation, { status: "completed" }>): Promise<void> {
    const key = this.operationKey(operation.channelId, operation.idempotencyKey);
    for (;;) {
      const currentRaw = await this.client.get(key);
      if (currentRaw === null) throw new Error("batch operation reservation changed");
      const current = deserialize<BatchOperation>(currentRaw);
      if (
        current.status !== "reserved" ||
        current.ceiling !== operation.ceiling ||
        current.channelId !== operation.channelId ||
        current.idempotencyKey !== operation.idempotencyKey
      ) {
        throw new Error("batch operation reservation changed");
      }
      const applied = await this.client.eval(COMPARE_AND_SET, {
        keys: [key],
        arguments: ["1", currentRaw, serialize(operation)],
      });
      if (Number(applied) === 1) return;
      await sleep(this.retryIntervalMs);
    }
  }

  async release(channelId: string, idempotencyKey: string): Promise<void> {
    const key = this.operationKey(channelId, idempotencyKey);
    for (;;) {
      const currentRaw = await this.client.get(key);
      if (currentRaw === null) return;
      const current = deserialize<BatchOperation>(currentRaw);
      if (current.status !== "reserved") return;
      const deleted = await this.client.eval(COMPARE_AND_DELETE, {
        keys: [key],
        arguments: [currentRaw],
      });
      if (Number(deleted) === 1) return;
      await sleep(this.retryIntervalMs);
    }
  }

  async commitWithChannel(
    channelId: string,
    idempotencyKey: string,
    updater: (
      channel: ChannelState | undefined,
      reservation: Extract<BatchOperation, { status: "reserved" }>,
    ) =>
      | { channel: ChannelState; operation: Extract<BatchOperation, { status: "completed" }> }
      | Promise<{
          channel: ChannelState;
          operation: Extract<BatchOperation, { status: "completed" }>;
        }>,
  ): Promise<{
    channel: ChannelState;
    operation: Extract<BatchOperation, { status: "completed" }>;
  }> {
    const channelKey = this.channelKey(channelId);
    const operationKey = this.operationKey(channelId, idempotencyKey);
    for (;;) {
      const [channelRaw, operationRaw] = await Promise.all([
        this.client.get(channelKey),
        this.client.get(operationKey),
      ]);
      if (operationRaw === null) throw new Error("batch operation reservation changed");
      const reservation = deserialize<BatchOperation>(operationRaw);
      if (
        reservation.status !== "reserved" ||
        reservation.channelId !== channelId ||
        reservation.idempotencyKey !== idempotencyKey
      ) {
        throw new Error("batch operation reservation changed");
      }
      const result = await updater(
        channelRaw === null ? undefined : deserialize<ChannelState>(channelRaw),
        reservation,
      );
      if (
        result.channel.channelId !== channelId ||
        result.operation.channelId !== channelId ||
        result.operation.idempotencyKey !== idempotencyKey ||
        result.operation.ceiling !== reservation.ceiling
      ) {
        throw new Error("atomic batch operation changed its binding");
      }
      const applied = await this.client.eval(COMMIT_CHANNEL_OPERATION, {
        keys: [channelKey, operationKey],
        arguments: [
          channelRaw === null ? "0" : "1",
          channelRaw ?? "",
          operationRaw,
          serialize(result.channel),
          serialize(result.operation),
        ],
      });
      if (Number(applied) === 1) return result;
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

  private operationKey(channelId: string, idempotencyKey: string): string {
    return `${this.operationPrefix}:${encodeURIComponent(channelId)}:${encodeURIComponent(idempotencyKey)}`;
  }
}

function serialize(value: ChannelState | BatchOperation): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? { $bigint: entry.toString() } : entry,
  );
}

function deserialize<T extends ChannelState | BatchOperation>(value: string): T {
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
  }) as T;
}

function createLeaseToken(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now()}:${Math.random().toString(36).slice(2)}:${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
