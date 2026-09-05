/* eslint-disable jsdoc/require-jsdoc */
import { address } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getMintDecoder,
  getTokenDecoder,
} from "@solana-program/token-2022";
import { TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS } from "../../constants";
import { getPaymentChannelsTreasuryOwner } from "../../payment-channels/onchain";
import type { FacilitatorRpcClient, FacilitatorSvmSigner } from "../../signer";
import { BatchError } from "../errors";

export async function settlementPath(
  mint: string,
  tokenProgram: string,
  payer: string,
  recipient: string,
  network: string,
) {
  const owners = [...new Set([payer, recipient, getPaymentChannelsTreasuryOwner(network)])];
  const atas = await Promise.all(
    owners.map(async owner => ({
      owner,
      address: (
        await findAssociatedTokenPda({
          mint: address(mint),
          owner: address(owner),
          tokenProgram: address(tokenProgram),
        })
      )[0],
    })),
  );
  return {
    atas,
    setupAccounts: atas.map(ata => [
      payer,
      ata.address,
      ata.owner,
      mint,
      "11111111111111111111111111111111",
      tokenProgram,
    ]),
  };
}

// Validate the exact setup's resulting accounts, including client-funded ATA creation.
export async function verifySettlementPath(args: {
  mint: string;
  tokenProgram: string;
  payer: string;
  recipient: string;
  network: string;
  transaction: string;
  signer: FacilitatorSvmSigner;
  rpc: FacilitatorRpcClient;
}): Promise<void> {
  const fail = () => new Error(`${BatchError.SETTLEMENT_SIMULATION}: unusable settlement path`);
  const { mint, tokenProgram } = args;
  if (tokenProgram !== TOKEN_PROGRAM_ADDRESS && tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS)
    throw fail();
  const { atas } = await settlementPath(
    mint,
    tokenProgram,
    args.payer,
    args.recipient,
    args.network,
  );
  const addresses = [mint, tokenProgram, ...atas.map(ata => ata.address)];
  // One confirmed batched read on the same injected transport as broadcast.
  if (!args.signer.getMultipleAccounts) throw fail();
  const before = await args.signer.getMultipleAccounts(addresses, args.network, {
    commitment: "confirmed",
    encoding: "base64",
  });
  if (before.length !== addresses.length || !before[0] || !before[1]) throw fail();
  const result = await args.rpc
    .simulateTransaction(
      args.transaction as never,
      {
        encoding: "base64",
        commitment: "confirmed",
        sigVerify: false,
        replaceRecentBlockhash: false,
        accounts: { encoding: "base64", addresses },
      } as never,
    )
    .send();
  const accounts = result.value.accounts;
  if (result.value.err || !accounts || accounts.length !== addresses.length) throw fail();
  const data = (index: number) => {
    const account = accounts[index];
    if (!account || account.executable || account.owner !== tokenProgram) throw fail();
    return Buffer.from(account.data[0], "base64");
  };
  try {
    const program = accounts[1];
    if (!program?.executable) throw fail();
    const mintBytes = data(0);
    if (tokenProgram === TOKEN_PROGRAM_ADDRESS && mintBytes.length !== 82) throw fail();
    const decodedMint = getMintDecoder().decode(mintBytes);
    if (!decodedMint.isInitialized) throw fail();
    // Extensions that alter transfer amounts, authority or CPI requirements need
    // a separate reviewed policy. Basic Token-2022 plus immutable ATAs is usable.
    if (decodedMint.extensions.__option === "Some" && decodedMint.extensions.value.length)
      throw fail();
    for (let i = 0; i < atas.length; i++) {
      const bytes = data(i + 2);
      if (tokenProgram === TOKEN_PROGRAM_ADDRESS && bytes.length !== 165) throw fail();
      const token = getTokenDecoder().decode(bytes);
      if (token.mint !== mint || token.owner !== atas[i]!.owner || token.state !== 1) throw fail();
      if (
        token.extensions.__option === "Some" &&
        token.extensions.value.some(ext => ext.__kind !== "ImmutableOwner")
      )
        throw fail();
    }
  } catch {
    throw fail();
  }
}
