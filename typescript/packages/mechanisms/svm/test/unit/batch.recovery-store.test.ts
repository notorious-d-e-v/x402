import { describe, expect, it } from "vitest";

import {
  decodeBroadcastReservation,
  encodeBroadcastReservation,
  forgetBroadcastReservation,
  InMemoryBatchPendingSettlementStore,
  prepareBroadcastReservation,
  recordedExpectedDeposit,
} from "../../src/batch-settlement/facilitator/recovery";

const KEY = "batch:topup:network:wire";
const NETWORK = "solana:test";

describe("batch broadcast reservation recovery", () => {
  it("round-trips immutable top-up targets and accepts legacy signatures", () => {
    expect(encodeBroadcastReservation("plain")).toBe("plain");
    expect(decodeBroadcastReservation("legacy-signature")).toEqual({
      signature: "legacy-signature",
    });
    expect(decodeBroadcastReservation(encodeBroadcastReservation("signature", 11_000n))).toEqual({
      expectedDeposit: 11_000n,
      signature: "signature",
    });
    expect(decodeBroadcastReservation("batch:deposit:v1:broken:signature")).toEqual({
      signature: "batch:deposit:v1:broken:signature",
    });
    expect(decodeBroadcastReservation("batch:deposit:v1:-1:signature")).toEqual({
      signature: "batch:deposit:v1:-1:signature",
    });
    expect(decodeBroadcastReservation("batch:deposit:v1:18446744073709551616:signature")).toEqual({
      signature: "batch:deposit:v1:18446744073709551616:signature",
    });
    expect(decodeBroadcastReservation("batch:deposit:v1:missing-separator")).toEqual({
      signature: "batch:deposit:v1:missing-separator",
    });
  });

  it("atomically keeps the winner's wire and target", async () => {
    const store = new InMemoryBatchPendingSettlementStore();
    await expect(
      prepareBroadcastReservation(store, KEY, NETWORK, "winner", "winner-wire", 11_000n),
    ).resolves.toEqual({ owned: true });
    await expect(
      prepareBroadcastReservation(store, KEY, NETWORK, "loser", "loser-wire", 12_000n),
    ).resolves.toEqual({
      existing: encodeBroadcastReservation("winner", 11_000n),
      owned: false,
    });
    expect(await store.get(`batch:transaction:${NETWORK}:winner:wire`)).toBe("winner-wire");
    expect(await store.get(`batch:transaction:${NETWORK}:loser:wire`)).toBeUndefined();
    expect(await recordedExpectedDeposit(store, KEY, undefined, await store.get(KEY))).toBe(
      "11000",
    );
    await expect(
      prepareBroadcastReservation(store, KEY, NETWORK, "winner", "replacement-wire", 11_000n),
    ).resolves.toEqual({
      existing: encodeBroadcastReservation("winner", 11_000n),
      owned: false,
    });
    expect(await store.get(`batch:transaction:${NETWORK}:winner:wire`)).toBe("replacement-wire");
    await forgetBroadcastReservation(store, KEY, "winner");
    expect(await store.get(KEY)).toBeUndefined();
  });

  it("supports legacy durable stores without compare-and-set methods", async () => {
    const records = new Map<string, string>();
    const store = {
      get: async (key: string) => records.get(key),
      set: async (key: string, value: string) => {
        records.set(key, value);
      },
      delete: async (key: string) => {
        records.delete(key);
      },
    };
    await expect(
      prepareBroadcastReservation(store, KEY, NETWORK, "signature", "wire", 9_000n),
    ).resolves.toEqual({ owned: true });
    expect(await recordedExpectedDeposit(store, KEY, "completed", undefined)).toBe("9000");
    await forgetBroadcastReservation(store, KEY, "different");
    expect(records.has(KEY)).toBe(true);
    await forgetBroadcastReservation(store, KEY, "signature");
    expect(records.has(KEY)).toBe(false);
    expect(await recordedExpectedDeposit(store, KEY, undefined, undefined)).toBeUndefined();

    records.set(KEY, "legacy-signature");
    records.set(`${KEY}:expected-deposit`, "123");
    expect(await recordedExpectedDeposit(store, KEY, undefined, "legacy-signature")).toBe("123");
  });

  it("treats cleanup failures as best effort", async () => {
    const store = {
      delete: async () => undefined,
      get: async () => {
        throw new Error("store unavailable");
      },
      set: async () => undefined,
    };
    await expect(forgetBroadcastReservation(store, KEY, "signature")).resolves.toBeUndefined();
  });

  it("handles reservations that disappear during a losing compare-and-set", async () => {
    const records = new Map<string, string>();
    const store = {
      delete: async (key: string) => {
        records.delete(key);
      },
      get: async (key: string) => records.get(key),
      set: async (key: string, value: string) => {
        records.set(key, value);
      },
      setIfAbsent: async () => false,
    };
    await expect(
      prepareBroadcastReservation(store, KEY, NETWORK, "signature", "wire"),
    ).resolves.toEqual({ owned: false });
    expect(records.has(`batch:transaction:${NETWORK}:signature:wire`)).toBe(false);
    await expect(forgetBroadcastReservation(store, KEY, "signature")).resolves.toBeUndefined();
  });
});
