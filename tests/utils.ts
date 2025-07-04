import * as anchor from "@coral-xyz/anchor";
import * as spl from "@solana/spl-token";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { BN } from "bn.js";

export const createMint = async (
  provider: anchor.AnchorProvider,
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

export const createUserAndATA = async (
  provider: anchor.AnchorProvider,
  mint: PublicKey
): Promise<[Keypair, PublicKey]> => {
  const user = Keypair.generate();
  let token_airdrop = await provider.connection.requestAirdrop(
    user.publicKey,
    10 * LAMPORTS_PER_SOL
  );
  const latestBlockHash = await provider.connection.getLatestBlockhash();

  await provider.connection.confirmTransaction({
    blockhash: latestBlockHash.blockhash,
    lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
    signature: token_airdrop,
  });

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
  provider: anchor.AnchorProvider,
  mint: anchor.web3.PublicKey,
  totalAmount: number, // in raw tokens (not decimals applied yet)
  decimals: number
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
      totalAmount * 10 ** decimals,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  await provider.sendAndConfirm(tx);
  return senderATA;
};

export const fundATA = async (
  provider: anchor.AnchorProvider,
  mint: PublicKey,
  user: Keypair,
  userATA: PublicKey,
  decimals: number
): Promise<PublicKey> => {
  const tx = new Transaction().add(
    spl.createMintToInstruction(
      mint,
      userATA,
      provider.wallet.publicKey,
      15_000_000_000 * 10 ** decimals
    )
  );

  await provider.sendAndConfirm(tx, [user]);
  console.log("userata finding successful: ");
  return userATA;
};

export const getTokenBalance = async (
  tokenAccount: PublicKey,
  provider: anchor.AnchorProvider
) => {
  const account = await provider.connection
    .getTokenAccountBalance(tokenAccount)
    .catch(() => null);
  if (!account) {
    console.log("Token account not found:", tokenAccount.toBase58());
    return 0;
  }
  return new BN(account.value.uiAmount);
};

export async function createPDA(
  seeds: Buffer[],
  programId: PublicKey
): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddressSync(seeds, programId);
}
