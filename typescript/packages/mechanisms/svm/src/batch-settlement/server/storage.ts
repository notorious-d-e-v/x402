/**
 * Per-channel server state and the store that holds it.
 *
 * `batch-settlement` is stateful: the operator tracks each channel's deposit,
 * the highest accepted off-chain voucher (the watermark), and the on-chain
 * settled / distributed amounts. The default {@link MemoryChannelStore} is an
 * in-memory implementation with per-channel serialization; integrators swap in
 * a durable store for production. See the spec's §7 "Server state".
 */

import type { BatchChannelConfig } from "../types";

export type BatchChannelStatus = "open" | "closing" | "distributed";

/** Server-held state for a single channel, keyed by `channelId`. */
export interface ChannelState {
  /** Channel PDA (base58). */
  channelId: string;
  /** Channel payer / depositor (base58). */
  payer: string;
  /** Final payment receiver (base58). */
  receiver: string;
  /** Zero-share program payee and transaction sponsor. */
  feePayer: string;
  /** SPL mint (base58). */
  mint: string;
  /** Token program id for the mint (base58). */
  tokenProgram: string;
  /** Voucher signer = the client (base58). */
  payerAuthorizer: string;
  /** Reusable payer proof bound at open for server-signed channels. */
  authorizationSignature?: string | undefined;
  /** Optional server close authorizer from the challenge. */
  receiverAuthorizer?: string | undefined;
  /** Forced-close grace period. */
  withdrawDelay: number;
  /** Channel PDA salt and open-slot seed. */
  salt: bigint;
  openSlot: bigint;
  /** On-chain escrow deposit (base units). */
  deposit: bigint;
  /** Highest accepted off-chain cumulative (the watermark). */
  chargedCumulativeAmount: bigint;
  /** Highest signed voucher watermark, committed after serving. */
  signedMaxClaimable: bigint;
  /** On-chain settled watermark (advanced by `settleBatch`). */
  settled: bigint;
  /** Millisecond timestamp of the last confirmed onchain snapshot. */
  onchainSnapshotAt?: number | undefined;
  /** Cumulative distributed on-chain (base units). */
  payoutWatermark: bigint;
  /** Channel lifecycle status. */
  status: BatchChannelStatus;
  /** When a forced/cooperative close was requested (Unix seconds), if any. */
  closeRequestedAt?: number | undefined;
  /** The highest accepted voucher's signature (base58), for redemption. */
  highestVoucherSignature?: string | undefined;
  /** The highest accepted voucher's expiry (Unix seconds). */
  highestVoucherExpiresAt?: number | undefined;
  /** Canonical wire configuration retained for response/replay binding. */
  channelConfig: BatchChannelConfig;
  /** The broadcast `open` signature, returned in the deposit settlement response. */
  openSignature?: string | undefined;
  /** Broadcast signature for the payer-forced request_close transition. */
  closeSignature?: string | undefined;
  /** Request ceilings reserved while verified handlers execute. */
  reservations?:
    | Record<
        string,
        {
          ceiling: bigint;
          expiresAt: number;
          idempotencyKey?: string | undefined;
          kind: "client" | "server" | "close";
        }
      >
    | undefined;
}

/**
 * Channel store contract. `update` performs an atomic read-modify-write so that
 * concurrent voucher acceptance for the same channel is serialized.
 */
export interface ChannelStore {
  /**
   * True only when records and leases survive process loss and are shared by
   * every server/worker instance using this store.
   */
  readonly durable?: boolean;

  /**
   * Fetch a channel's state.
   *
   * @param channelId - Channel PDA (base58)
   * @returns The state, or undefined if unknown
   */
  get(channelId: string): Promise<ChannelState | undefined>;

  /**
   * Every channel this store holds.
   *
   * Optional: only a redemption worker needs to enumerate, and a store built
   * for request serving alone can leave it out. Implementations may return a
   * weakly-consistent snapshot — a worker reconciles each channel against the
   * chain anyway.
   */
  list?(): Promise<ChannelState[]>;

  /**
   * Insert or overwrite a channel's state.
   *
   * @param state - The channel state
   */
  put(state: ChannelState): Promise<void>;

  /**
   * Atomically read-modify-write a channel under a per-channel lock. The updater
   * runs with exclusive access; concurrent updates to the same channel queue.
   *
   * @param channelId - Channel PDA (base58)
   * @param updater - Receives the current state (or undefined) and returns the new state
   * @returns The written state
   */
  update(
    channelId: string,
    updater: (current: ChannelState | undefined) => ChannelState | Promise<ChannelState>,
  ): Promise<ChannelState>;

  /**
   * Try to acquire a cross-process worker lease. Durable production stores
   * should implement this with an atomic compare-and-set (for example Redis
   * `SET NX PX` or a database advisory lock) and return a fencing-safe release
   * function. Request serving does not require it; redemption workers do.
   */
  acquireLease?(key: string, ttlMs: number): Promise<(() => Promise<void>) | undefined>;
}

/** In-memory {@link ChannelStore} with per-channel serialization. */
export class MemoryChannelStore implements ChannelStore {
  readonly durable = false;
  private readonly channels = new Map<string, ChannelState>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly leases = new Map<string, symbol>();

  /** @inheritdoc */
  /**
   * @inheritdoc
   * @returns Every channel this store holds
   */
  list(): Promise<ChannelState[]> {
    return Promise.resolve([...this.channels.values()]);
  }

  /**
   * @inheritdoc
   * @param channelId - Channel PDA (base58)
   * @returns The state, or undefined if unknown
   */
  get(channelId: string): Promise<ChannelState | undefined> {
    return Promise.resolve(this.channels.get(channelId));
  }

  /** @inheritdoc */
  put(state: ChannelState): Promise<void> {
    this.channels.set(state.channelId, state);
    return Promise.resolve();
  }

  /** @inheritdoc */
  async update(
    channelId: string,
    updater: (current: ChannelState | undefined) => ChannelState | Promise<ChannelState>,
  ): Promise<ChannelState> {
    const prior = this.locks.get(channelId) ?? Promise.resolve();
    const run = prior.then(async () => {
      const next = await updater(this.channels.get(channelId));
      this.channels.set(channelId, next);
      return next;
    });
    // Keep the lock chain alive regardless of this run's outcome.
    this.locks.set(
      channelId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** @inheritdoc */
  async acquireLease(key: string): Promise<(() => Promise<void>) | undefined> {
    if (this.leases.has(key)) return undefined;
    const token = Symbol(key);
    this.leases.set(key, token);
    return async () => {
      if (this.leases.get(key) === token) this.leases.delete(key);
    };
  }
}
