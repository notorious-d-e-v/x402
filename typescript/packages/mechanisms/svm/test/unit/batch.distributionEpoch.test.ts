import {
  generateKeyPairSigner,
  getBase64Codec,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import { InMemoryPendingSettlementStore } from "@x402/core/facilitator";
import { describe, expect, it, vi } from "vitest";
import { BatchSvmScheme } from "../../src/batch-settlement/facilitator/scheme";
import { BatchChannelManager } from "../../src/batch-settlement/server/channelManager";
import { MemoryChannelStore } from "../../src/batch-settlement/server/storage";
import { buildDepositPayload, signBatchVoucher } from "../../src/batch-settlement/client/channel";
import { getChannelEncoder } from "../../src/payment-channels/generated/accounts/channel";
import { getChannelDistributionHash } from "../../src/payment-channels/facilitator";
import { PAYMENT_CHANNELS_PROGRAM_ID } from "../../src/payment-channels/onchain";
import { TOKEN_PROGRAM_ADDRESS, SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import { toFacilitatorSvmSigner } from "../../src/signer";

// Deterministic account ledger, not a validator or evidence of a live payout.
// SDK signs/serializes instructions; the ledger applies their monetary effects
// and independently serves encoded confirmed channel state.
async function ledger() {
  const payer = await generateKeyPairSigner(),
    fee = await generateKeyPairSigner();
  const network = SOLANA_DEVNET_CAIP2,
    mint = USDC_DEVNET_ADDRESS,
    receiver = USDC_MAINNET_ADDRESS;
  const built = await buildDepositPayload({
    payer,
    feePayer: fee.address,
    mint,
    receiver,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    openSlot: 123n,
    withdrawDelay: 900,
    depositAmount: 10000n,
    firstCharge: 1000n,
    blockhash: { blockhash: mint, lastValidBlockHeight: 1n },
  });
  const channel = {
    discriminator: 1,
    version: 1,
    bump: 1,
    payer: payer.address,
    payee: fee.address,
    authorizedSigner: payer.address,
    rentPayer: fee.address,
    mint,
    salt: BigInt(built.payload.channelConfig.salt),
    openSlot: 123n,
    deposit: 10000n,
    settlement: { settled: 0n, payoutWatermark: 0n },
    closureStartedAt: 0n,
    payerWithdrawnAt: 0n,
    gracePeriod: 900,
    status: 0,
    distributionHash: [...getChannelDistributionHash([{ recipient: receiver, bps: 10000 }])],
  };
  const requirements = {
    scheme: "batch-settlement",
    network,
    asset: mint,
    payTo: receiver,
    amount: "1000",
    maxTimeoutSeconds: 300,
    extra: { feePayer: fee.address, tokenProgram: TOKEN_PROGRAM_ADDRESS, withdrawDelay: 900 },
  } as const;
  const balance = { receiver: 0n, escrow: 10000n };
  let timeout = false,
    landOnSend = true;
  const pendingWires = new Map<string, string>();
  const account = (id: string) =>
    id === mint
      ? { owner: TOKEN_PROGRAM_ADDRESS, data: "", lamports: 1n }
      : id === built.channelId
        ? {
            owner: PAYMENT_CHANNELS_PROGRAM_ID,
            data: Buffer.from(getChannelEncoder().encode(channel)).toString("base64"),
            lamports: 1n,
          }
        : null;
  const land = (wire: string) => {
    const tx = getTransactionDecoder().decode(getBase64Codec().encode(wire));
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    for (let i = 0; i < message.instructions.length; i++) {
      const ix = message.instructions[i]!;
      if (message.staticAccounts[ix.programAddressIndex] !== PAYMENT_CHANNELS_PROGRAM_ID) continue;
      if (ix.data![0] === 2) {
        const voucherIx = Buffer.from(message.instructions[i - 1]!.data!);
        const messageOffset = voucherIx.readUInt16LE(10);
        channel.settlement.settled = voucherIx.readBigUInt64LE(messageOffset + 34);
      } else if (ix.data![0] === 7) {
        const delta = channel.settlement.settled - channel.settlement.payoutWatermark;
        balance.receiver += delta;
        balance.escrow -= delta;
        channel.settlement.payoutWatermark = channel.settlement.settled;
      } else throw new Error(`unexpected ledger instruction ${ix.data![0]}`);
    }
  };
  const send = vi.fn(async (wire: string) => {
    const sig = `local-signature-${send.mock.calls.length}`;
    if (landOnSend) land(wire);
    else pendingWires.set(sig, wire);
    return sig;
  });
  const pending = new InMemoryPendingSettlementStore();
  const signer = {
    ...toFacilitatorSvmSigner(fee),
    getAccountInfo: async (id: string) => account(id),
    getMultipleAccounts: async (ids: readonly string[]) => ids.map(account),
    getLatestBlockhash: async () => ({ blockhash: mint, lastValidBlockHeight: 1n }),
    simulateTransaction: async () => {},
    sendTransaction: send,
    confirmTransaction: async () => {
      if (timeout) throw new Error("injected confirmation timeout");
    },
  };
  const restart = () => new BatchSvmScheme(signer, { pendingSettlementStore: pending });
  const payment = (payload: unknown) =>
    ({ x402Version: 2, accepted: requirements, payload }) as any;
  const distribution = payment({
    type: "settle",
    channels: [{ channelId: built.channelId, channelConfig: built.payload.channelConfig }],
  });
  const claim = async (scheme: BatchSvmScheme, cumulative: bigint) => {
    const voucher = await signBatchVoucher(payer, {
      channelId: built.channelId,
      maxClaimableAmount: cumulative,
      expiresAt: 0,
    });
    return scheme.settle(
      payment({
        type: "claim",
        claims: [
          {
            signature: voucher.signature,
            voucher: { ...voucher, channelConfig: built.payload.channelConfig },
          },
        ],
      }),
      requirements,
    );
  };
  return {
    channel,
    balance,
    built,
    requirements,
    signer,
    send,
    pending,
    restart,
    distribution,
    claim,
    setTimeout: (value: boolean) => {
      timeout = value;
    },
    setLandOnSend: (value: boolean) => {
      landOnSend = value;
    },
    landPending: () => {
      for (const wire of pendingWires.values()) land(wire);
      pendingWires.clear();
    },
  };
}

describe("confirmed distribution epochs", () => {
  it("pays identical bodies across two epochs; same-epoch retries and restart do not pay twice", async () => {
    const f = await ledger();
    let scheme = f.restart();
    for (const cumulative of [1000n, 3000n]) {
      expect((await f.claim(scheme, cumulative)).success).toBe(true);
      expect(await scheme.verify(f.distribution, f.requirements)).toMatchObject({
        isValid: true,
        extra: {
          distributionEpoch: [{ channelId: f.built.channelId, settled: cumulative.toString() }],
        },
      });
      expect(await scheme.settle(f.distribution, f.requirements)).toMatchObject({
        success: true,
        extra: {
          payouts: [{ channelId: f.built.channelId, payoutWatermark: cumulative.toString() }],
        },
      });
      scheme = f.restart();
      const count = f.send.mock.calls.length;
      expect((await scheme.settle(f.distribution, f.requirements)).success).toBe(true);
      expect(f.send.mock.calls.length).toBe(count);
      expect(f.balance.receiver).toBe(cumulative);
      expect(f.channel.settlement).toEqual({ settled: cumulative, payoutWatermark: cumulative });
      expect(f.balance.escrow + f.balance.receiver).toBe(f.channel.deposit);
    }
  });
  it.each([false, true])(
    "recovers confirmation timeout (landed=%s) after restart",
    async landed => {
      const f = await ledger();
      const scheme = f.restart();
      expect((await f.claim(scheme, 1000n)).success).toBe(true);
      f.setTimeout(true);
      f.setLandOnSend(landed);
      expect(await scheme.settle(f.distribution, f.requirements)).toMatchObject({
        success: false,
        errorReason: "settlement_pending",
      });
      const count = f.send.mock.calls.length;
      expect((await f.restart().settle(f.distribution, f.requirements)).success).toBe(false);
      expect(f.send.mock.calls.length).toBe(count);
      f.landPending();
      f.setTimeout(false);
      f.setLandOnSend(true);
      // A new claim can land while the older payout's confirmation is ambiguous.
      expect((await f.claim(f.restart(), 3000n)).success).toBe(true);
      expect((await f.restart().settle(f.distribution, f.requirements)).success).toBe(true);
      expect(f.balance.receiver).toBe(3000n);
      expect(f.channel.settlement.payoutWatermark).toBe(3000n);
      expect(f.balance.escrow).toBe(7000n);
      expect(f.send.mock.calls.length).toBe(count + 2); // one new claim + only its remaining payout
    },
  );
  it("worker accounts charged, settled, payout and escrow across epochs", async () => {
    const f = await ledger();
    const store = new MemoryChannelStore();
    const onError = vi.fn();
    for (const cumulative of [1000n, 3000n]) {
      const voucher = await signBatchVoucher(await generateKeyPairSigner(), {
        channelId: f.built.channelId,
        maxClaimableAmount: cumulative,
        expiresAt: 0,
      });
      // Claims are independently exercised above; seed already confirmed claims
      // and accepted charges to isolate the worker's payout-response contract.
      expect((await f.claim(f.restart(), cumulative)).success).toBe(true);
      await store.put({
        ...f.built.payload.channelConfig,
        channelConfig: f.built.payload.channelConfig,
        channelId: f.built.channelId,
        feePayer: f.requirements.extra.feePayer,
        mint: f.requirements.asset,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        salt: BigInt(f.built.payload.channelConfig.salt),
        openSlot: 123n,
        deposit: 10000n,
        chargedCumulativeAmount: cumulative,
        signedMaxClaimable: cumulative,
        highestVoucherSignature: voucher.signature,
        settled: cumulative,
        payoutWatermark: f.balance.receiver,
        status: "open",
      });
      const manager = new BatchChannelManager({
        store,
        requirements: f.requirements,
        onError,
        settle: (p, r) => f.restart().settle(p as any, r),
      });
      expect((await manager.redeem()).distributed).toEqual([f.built.channelId]);
      const state = (await store.get(f.built.channelId))!;
      expect(state.chargedCumulativeAmount).toBe(state.settled);
      expect(state.settled).toBe(state.payoutWatermark);
      expect(state.payoutWatermark).toBe(f.balance.receiver);
      expect(state.deposit).toBe(f.balance.receiver + f.balance.escrow);
    }
    expect(onError).not.toHaveBeenCalled();
  });
});
