/** Idempotent server-mode request records, separate from channel accounting. */

import type { SettleResponse } from "@x402/core/types";

import type { BatchSettlementReceipt } from "../types";
import type { ChannelState } from "./storage";

export type BatchOperation =
  | {
      status: "reserved";
      channelId: string;
      idempotencyKey: string;
      ceiling: bigint;
      expiresAt: number;
    }
  | {
      status: "completed";
      channelId: string;
      idempotencyKey: string;
      ceiling: bigint;
      actual: bigint;
      cumulative: bigint;
      receipt: BatchSettlementReceipt;
      response: SettleResponse;
    };

export interface BatchOperationStore {
  /** True when records survive process loss and are shared by every server instance. */
  readonly durable?: boolean;
  /** Fetch a reserved or completed request operation. */
  get(channelId: string, idempotencyKey: string): Promise<BatchOperation | undefined>;
  /** Atomically create a request reservation unless the operation already exists. */
  reserve(
    channelId: string,
    idempotencyKey: string,
    ceiling: bigint,
    expiresAt: number,
  ): Promise<{ created: boolean; operation: BatchOperation }>;
  /** Atomically replace a reservation with its completed receipt and response. */
  complete(operation: Extract<BatchOperation, { status: "completed" }>): Promise<void>;
  /** Release an uncompleted reservation after failed or canceled work. */
  release(channelId: string, idempotencyKey: string): Promise<void>;

  /**
   * Atomically update channel accounting and complete its reserved operation.
   *
   * Server-authorized requests need this cross-record commit in production: a
   * receipt must never become replayable unless the matching cumulative
   * watermark is committed at the same instant. Implementations retry the
   * updater when another request advances the channel first.
   */
  commitWithChannel?(
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
  }>;
}

/** In-memory operation store used by the reference implementation. */
export class MemoryBatchOperationStore implements BatchOperationStore {
  readonly durable = false;
  private readonly operations = new Map<string, BatchOperation>();
  private readonly locks = new Map<string, Promise<unknown>>();

  /** @inheritdoc */
  get(channelId: string, idempotencyKey: string): Promise<BatchOperation | undefined> {
    return Promise.resolve(this.operations.get(operationKey(channelId, idempotencyKey)));
  }

  /** @inheritdoc */
  reserve(
    channelId: string,
    idempotencyKey: string,
    ceiling: bigint,
    expiresAt: number,
  ): Promise<{ created: boolean; operation: BatchOperation }> {
    return this.withLock(channelId, idempotencyKey, () => {
      const key = operationKey(channelId, idempotencyKey);
      const existing = this.operations.get(key);
      if (existing && existing.ceiling !== ceiling) {
        throw new Error("batch operation ceiling changed for an idempotency key");
      }
      if (existing?.status === "completed" || (existing && existing.expiresAt > Date.now())) {
        return { created: false, operation: existing };
      }
      const operation: BatchOperation = {
        status: "reserved",
        channelId,
        idempotencyKey,
        ceiling,
        expiresAt,
      };
      this.operations.set(key, operation);
      return { created: true, operation };
    });
  }

  /** @inheritdoc */
  complete(operation: Extract<BatchOperation, { status: "completed" }>): Promise<void> {
    return this.withLock(operation.channelId, operation.idempotencyKey, () => {
      const key = operationKey(operation.channelId, operation.idempotencyKey);
      const existing = this.operations.get(key);
      if (!existing || existing.status !== "reserved" || existing.ceiling !== operation.ceiling) {
        throw new Error("batch operation reservation changed");
      }
      this.operations.set(key, operation);
    });
  }

  /** @inheritdoc */
  release(channelId: string, idempotencyKey: string): Promise<void> {
    return this.withLock(channelId, idempotencyKey, () => {
      const key = operationKey(channelId, idempotencyKey);
      if (this.operations.get(key)?.status === "reserved") this.operations.delete(key);
    });
  }

  /**
   * Run one operation-key mutation at a time.
   *
   * @param channelId - Channel identifier
   * @param idempotencyKey - Request identifier
   * @param operation - Mutation to serialize
   * @returns The mutation result
   */
  private async withLock<T>(
    channelId: string,
    idempotencyKey: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const key = operationKey(channelId, idempotencyKey);
    const prior = this.locks.get(key) ?? Promise.resolve();
    const run = prior.then(operation);
    this.locks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

/**
 * Build the collision-free in-memory key for one request operation.
 *
 * @param channelId - Channel identifier
 * @param idempotencyKey - Request identifier
 * @returns Internal map key
 */
function operationKey(channelId: string, idempotencyKey: string): string {
  return `${channelId}\u0000${idempotencyKey}`;
}
