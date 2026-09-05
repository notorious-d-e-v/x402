import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  decompileTransactionMessage,
  partiallySignTransactionMessageWithSigners,
  addSignersToTransactionMessage,
} from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token-2022";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BatchSvmScheme } from "../../src/batch-settlement/facilitator/scheme";
import { settlementPath } from "../../src/batch-settlement/facilitator/settlementPath";
import { buildDepositPayload } from "../../src/batch-settlement/client/channel";
import { buildTopUpPaymentChannelTransaction } from "../../src/payment-channels/open";
import { getChannelEncoder } from "../../src/payment-channels/generated/accounts/channel";
import { getChannelDistributionHash } from "../../src/payment-channels/facilitator";
import { PAYMENT_CHANNELS_PROGRAM_ID } from "../../src/payment-channels/onchain";
import { TOKEN_PROGRAM_ADDRESS, SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import { toFacilitatorSvmSigner } from "../../src/signer";

const mint = USDC_DEVNET_ADDRESS,
  recipient = USDC_MAINNET_ADDRESS,
  network = SOLANA_DEVNET_CAIP2;
let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>, feePayer: typeof payer;
let built: Awaited<ReturnType<typeof buildDepositPayload>>;
let path: Awaited<ReturnType<typeof settlementPath>>;
const wireAccount = (bytes: Uint8Array, owner: string = TOKEN_PROGRAM_ADDRESS) => ({
  data: [Buffer.from(bytes).toString("base64"), "base64"],
  owner,
  executable: false,
  lamports: 10000000n,
});
const mintAccount = () => {
  const b = Buffer.alloc(82);
  b[44] = 6;
  b[45] = 1;
  return wireAccount(b);
};
const tokenAccount = (owner: string) => {
  const b = Buffer.alloc(165);
  b.set(getAddressEncoder().encode(address(mint)));
  b.set(getAddressEncoder().encode(address(owner)), 32);
  b.writeBigUInt64LE(100000n, 64);
  b[108] = 1;
  return wireAccount(b);
};
beforeAll(async () => {
  payer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  built = await buildDepositPayload({
    payer,
    feePayer: feePayer.address,
    mint,
    receiver: recipient,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    openSlot: 123n,
    withdrawDelay: 900,
    depositAmount: 10000n,
    firstCharge: 1000n,
    blockhash: { blockhash: mint, lastValidBlockHeight: 1000n },
  });
  path = await settlementPath(mint, TOKEN_PROGRAM_ADDRESS, payer.address, recipient, network);
});
async function fixture(topup = false) {
  const accounts = new Map<string, any>([
    [mint, mintAccount()],
    [TOKEN_PROGRAM_ADDRESS, { ...wireAccount(Buffer.alloc(0)), executable: true }],
    ...path.atas.map(a => [a.address, tokenAccount(a.owner)] as [string, any]),
  ]);
  const payload = structuredClone(built.payload);
  if (topup) {
    const tx = await buildTopUpPaymentChannelTransaction({
      payer,
      feePayer: feePayer.address,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      channelId: built.channelId,
      amount: 10000n,
      blockhash: { blockhash: mint, lastValidBlockHeight: 1000n },
    });
    payload.deposit.transaction = tx.transaction;
    accounts.set(
      built.channelId,
      wireAccount(
        getChannelEncoder().encode({
          discriminator: 1,
          version: 1,
          bump: 1,
          payer: payer.address,
          payee: feePayer.address,
          mint,
          authorizedSigner: payer.address,
          rentPayer: feePayer.address,
          salt: BigInt(payload.channelConfig.salt),
          openSlot: 123n,
          deposit: 10000n,
          gracePeriod: 900,
          status: 0,
          closureStartedAt: 0n,
          payerWithdrawnAt: 0n,
          settlement: { settled: 0n, payoutWatermark: 0n },
          distributionHash: [...getChannelDistributionHash([{ bps: 10000, recipient }])],
        }),
        PAYMENT_CHANNELS_PROGRAM_ID,
      ),
    );
  }
  const sign = vi.fn(async () => {
    throw new Error("test must not co-sign rejected deposits");
  });
  const reads = vi.fn(async (keys: readonly string[]) => keys.map(k => accounts.get(k) ?? null));
  const simulation = vi.fn((_wire: string, config: any) => ({
    send: async () => ({
      value: {
        err: null,
        accounts: config.accounts.addresses.map((k: string) => accounts.get(k) ?? null),
      },
    }),
  }));
  const scheme = new BatchSvmScheme(
    {
      ...toFacilitatorSvmSigner(feePayer),
      signTransaction: sign,
      getAccountInfo: async key => accounts.get(key) ?? null,
      getMultipleAccounts: reads,
    },
    { rpcClient: { simulateTransaction: simulation } as never },
  );
  const requirements = {
    scheme: "batch-settlement",
    network,
    amount: "1000",
    asset: mint,
    payTo: recipient,
    maxTimeoutSeconds: 300,
    extra: { feePayer: feePayer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS, withdrawDelay: 900 },
  };
  const payment = { x402Version: 2, accepted: requirements, payload } as any;
  return { accounts, sign, reads, simulation, scheme, requirements: requirements as any, payment };
}

describe.each([false, true])("deposit settlement path (topup=%s)", topup => {
  for (const role of ["payer", "recipient", "treasury"] as const) {
    it.each([
      "missing",
      "frozen",
      "uninitialized",
      "malformed",
      "wrong-owner",
      "wrong-mint",
      "wrong-program",
    ])(`rejects ${role} %s before escrow`, async defect => {
      const f = await fixture(topup);
      const ata = path.atas[role === "payer" ? 0 : role === "recipient" ? 1 : 2]!;
      const original = f.accounts.get(ata.address);
      const bytes = Buffer.from(original.data[0], "base64");
      if (defect === "missing") f.accounts.delete(ata.address);
      else if (defect === "wrong-program")
        f.accounts.set(ata.address, { ...original, owner: mint });
      else {
        if (defect === "frozen") bytes[108] = 2;
        if (defect === "uninitialized") bytes[108] = 0;
        if (defect === "wrong-owner") bytes.set(getAddressEncoder().encode(address(mint)), 32);
        if (defect === "wrong-mint") bytes.set(getAddressEncoder().encode(address(recipient)), 0);
        f.accounts.set(
          ata.address,
          wireAccount(defect === "malformed" ? bytes.subarray(0, 90) : bytes),
        );
      }
      expect((await f.scheme.verify(f.payment, f.requirements)).isValid).toBe(false);
      expect((await f.scheme.settle(f.payment, f.requirements)).success).toBe(false);
      expect(f.sign).not.toHaveBeenCalled();
    });
  }
  it("reverifies an already confirmed open without simulating escrow creation again", async () => {
    const f = await fixture(true);
    f.payment.payload = structuredClone(built.payload);
    f.simulation.mockImplementation(() => ({
      send: async () => ({ value: { err: "already open", accounts: [] } }),
    }));
    expect((await f.scheme.verify(f.payment, f.requirements)).isValid).toBe(true);
    expect(f.simulation).not.toHaveBeenCalled();
    expect(f.sign).not.toHaveBeenCalled();
  });

  it("accepts usable accounts and simulates the exact client-signed bytes", async () => {
    const f = await fixture(topup);
    expect(await f.scheme.verify(f.payment, f.requirements)).toEqual(
      expect.objectContaining({ isValid: true }),
    );
    expect(f.simulation).toHaveBeenCalledWith(
      f.payment.payload.deposit.transaction,
      expect.objectContaining({
        sigVerify: false,
        replaceRecentBlockhash: false,
        accounts: {
          encoding: "base64",
          addresses: [mint, TOKEN_PROGRAM_ADDRESS, ...path.atas.map(a => a.address)],
        },
      }),
    );
    expect(f.reads).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "malformed", "wrong-owner", "uninitialized"])(
    "rejects %s mint",
    async defect => {
      const f = await fixture(topup);
      const a = mintAccount();
      const b = Buffer.from(a.data[0], "base64");
      if (defect === "missing") f.accounts.delete(mint);
      else if (defect === "wrong-owner") f.accounts.set(mint, { ...a, owner: recipient });
      else {
        if (defect === "uninitialized") b[45] = 0;
        f.accounts.set(mint, wireAccount(defect === "malformed" ? b.subarray(0, 20) : b));
      }
      expect((await f.scheme.verify(f.payment, f.requirements)).isValid).toBe(false);
      expect(f.sign).not.toHaveBeenCalled();
    },
  );
  it("accepts exact payer-signed ATA setup and rejects a missing simulated result", async () => {
    const f = await fixture(topup);
    const ata = path.atas[1]!;
    const tx = getTransactionDecoder().decode(
      getBase64Codec().encode(f.payment.payload.deposit.transaction),
    );
    const message = decompileTransactionMessage(
      getCompiledTransactionMessageDecoder().decode(tx.messageBytes),
    );
    const setup = getCreateAssociatedTokenIdempotentInstruction({
      payer,
      ata: address(ata.address),
      owner: address(recipient),
      mint: address(mint),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const instructions = [...message.instructions];
    const index = instructions.findIndex(ix => ix.programAddress === PAYMENT_CHANNELS_PROGRAM_ID);
    instructions.splice(index, 0, setup);
    const signed = await partiallySignTransactionMessageWithSigners(
      addSignersToTransactionMessage([payer], { ...message, instructions }),
    );
    f.payment.payload.deposit.transaction = getBase64EncodedWireTransaction(signed);
    const after = f.accounts.get(ata.address);
    f.accounts.delete(ata.address);
    f.simulation.mockImplementation((_wire, config) => ({
      send: async () => ({
        value: {
          err: null,
          accounts: config.accounts.addresses.map((k: string) =>
            k === ata.address ? after : (f.accounts.get(k) ?? null),
          ),
        },
      }),
    }));
    expect(await f.scheme.verify(f.payment, f.requirements)).toEqual(
      expect.objectContaining({ isValid: true }),
    );
    f.simulation.mockImplementation((_wire, config) => ({
      send: async () => ({
        value: {
          err: null,
          accounts: config.accounts.addresses.map((k: string) => f.accounts.get(k) ?? null),
        },
      }),
    }));
    expect((await f.scheme.verify(f.payment, f.requirements)).isValid).toBe(false);
  });
});
