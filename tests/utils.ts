import * as anchor from "@coral-xyz/anchor";
import { u64 } from "@solana/buffer-layout-utils";
import * as spl from "@solana/spl-token";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { BankrunProvider } from "anchor-bankrun";
import { ProgramTestContext } from "solana-bankrun";
import { SECOND_PER_MONTH } from "./constant";

export const createMint = async (
  provider: BankrunProvider,
  decimals: number
): Promise<PublicKey> => {
  const tokenMint = new anchor.web3.Keypair();
  const lamportForMint =
    await provider.connection.getMinimumBalanceForRentExemption(
      spl.MintLayout.span
    );
  let tx = new anchor.web3.Transaction();

  tx.add(
    anchor.web3.SystemProgram.createAccount({
      programId: spl.TOKEN_PROGRAM_ID,
      space: spl.MintLayout.span,
      fromPubkey: provider.wallet.publicKey,
      newAccountPubkey: tokenMint.publicKey,
      lamports: lamportForMint,
    })
  );

  tx.add(
    spl.createInitializeMintInstruction(
      tokenMint.publicKey,
      decimals,
      provider.wallet.publicKey,
      provider.wallet.publicKey,
      spl.TOKEN_PROGRAM_ID
    )
  );

  const signature = await provider.sendAndConfirm(tx, [tokenMint]);
  console.log(`Created token mint at: ${signature}`);

  return tokenMint.publicKey;
};

function fakeAirdrop(
  ctx: ProgramTestContext,
  pubkey: PublicKey,
  lamports: number
) {
  ctx.setAccount(pubkey, {
    lamports,
    owner: SystemProgram.programId,
    executable: false,
    data: Buffer.alloc(0),
  });
}
export const createUserAndATA = async (
  ctx: ProgramTestContext,
  provider: BankrunProvider,
  mint: PublicKey
): Promise<[Keypair, PublicKey]> => {
  const user = Keypair.generate();

  fakeAirdrop(ctx, user.publicKey, 10 * LAMPORTS_PER_SOL);

  let userATA = await spl.getAssociatedTokenAddress(
    mint,
    user.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      user.publicKey,
      userATA,
      user.publicKey,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  );
  await provider.sendAndConfirm(tx, [user]);

  return [user, userATA];
};

export const createAndFundSenderATA = async (
  provider: BankrunProvider,
  mint: anchor.web3.PublicKey,
  rawAmount: bigint
): Promise<anchor.web3.PublicKey> => {
  const senderPubkey = provider.wallet.publicKey;

  const senderATA = await spl.getAssociatedTokenAddress(
    mint,
    senderPubkey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new anchor.web3.Transaction();

  tx.add(
    spl.createAssociatedTokenAccountInstruction(
      senderPubkey,
      senderATA,
      senderPubkey,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  );

  tx.add(
    spl.createMintToInstruction(
      mint,
      senderATA,
      senderPubkey,
      rawAmount,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  await provider.sendAndConfirm(tx);
  return senderATA;
};

export const getTokenBalance = async (
  tokenAccount: PublicKey,
  provider: BankrunProvider
): Promise<anchor.BN> => {
  const accountInfo = await provider.connection
    .getAccountInfo(tokenAccount)
    .catch(() => null);

  if (!accountInfo) {
    console.log("Token account not found:", tokenAccount.toBase58());
    return new BN(0);
  }

  const data = spl.AccountLayout.decode(accountInfo.data);
  const amountOrigin = data.amount;

  const amount = u64(amountOrigin.toString());

  return new BN(amount.property);
};

export function toRawUnitFromBN(amount: BN, decimals: number = 6): BN {
  const multiplier = new BN(10).pow(new BN(decimals));
  return amount.mul(multiplier);
}

export async function createPDA(
  seeds: Buffer[],
  programId: PublicKey
): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

export function getPassedMonths(
  startTime: number,
  currentTime: number,
  cliffMonths: number,
  bufferSeconds: number = 0
): number {
  const passedSeconds =
    currentTime +
    bufferSeconds -
    startTime -
    cliffMonths * Number(SECOND_PER_MONTH); // (now + bufferSecond) - startTime - (cliffMonth * SECOND_PER_MONTH)

  if (passedSeconds < 0) return 0;

  return Math.floor(passedSeconds / Number(SECOND_PER_MONTH));
}

export function sleep(ms: number = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
