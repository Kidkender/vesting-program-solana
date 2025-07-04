import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createPDA,
  createUserAndATA,
  createMint,
  getTokenBalance,
  createAndFundSenderATA,
} from "./utils";
import { Vesting } from "../target/types/vesting";
import { assert } from "chai";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BN } from "bn.js";
import { Keypair, PublicKey, Connection } from "@solana/web3.js";

describe("vesting", () => {
  const provider = anchor.AnchorProvider.env();
  console.log(provider.connection.rpcEndpoint);
  anchor.setProvider(provider);
  const program = anchor.workspace.Vesting as Program<Vesting>;

  let mintAddress,
    sender,
    senderATA,
    dataAccount,
    dataBump,
    escrowWallet,
    escrowBump,
    beneficiaryArray;

  let founderA,
    founderB,
    founderAATA,
    founderBATA,
    teamA,
    teamAATA,
    teamB,
    teamBATA;
  let _dataAccountAfterInit;
  const now = Math.floor(Date.now() / 1000);
  const secondsPerMonth = 1;
  const bufferSeconds = 5;
  const startTime = now + bufferSeconds;
  //   const startTime = now + secondsPerMonth;
  const oneYearAgo = 12 * secondsPerMonth;
  const fourYearsAgo = 48 * secondsPerMonth;
  let totalAmountInit = new BN(0);

  const decimals = 6;
  before(async () => {
    mintAddress = await createMint(provider, decimals);
    sender = provider.wallet.publicKey;
    senderATA = await createAndFundSenderATA(
      provider,
      mintAddress,
      15_000_000_000,
      decimals
    );

    [dataAccount, dataBump] = await createPDA(
      [Buffer.from("data_account"), mintAddress.toBuffer()],
      program.programId
    );
    [escrowWallet, escrowBump] = await createPDA(
      [Buffer.from("escrow_wallet"), mintAddress.toBuffer()],
      program.programId
    );

    [founderA, founderAATA] = await createUserAndATA(provider, mintAddress);
    [founderB, founderBATA] = await createUserAndATA(provider, mintAddress);
    [teamA, teamAATA] = await createUserAndATA(provider, mintAddress);
    [teamB, teamBATA] = await createUserAndATA(provider, mintAddress);

    beneficiaryArray = [
      {
        key: founderA.publicKey,
        allocatedTokens: new anchor.BN(5_000_000_000), // 5B
        claimedTokens: new anchor.BN(0),
        startTime: new BN(startTime),
        cliffMonths: 0,
        totalMonths: 48,
      },
      {
        key: founderB.publicKey,
        allocatedTokens: new anchor.BN(5_000_000_000),
        claimedTokens: new anchor.BN(0),
        startTime: new BN(startTime),
        cliffMonths: 0,
        totalMonths: 12,
      },
      {
        key: teamA.publicKey,
        allocatedTokens: new anchor.BN(333_333_333),
        claimedTokens: new anchor.BN(0),
        startTime: new anchor.BN(startTime),
        cliffMonths: 12,
        totalMonths: 48,
      },
      {
        key: teamB.publicKey,
        allocatedTokens: new anchor.BN(166_666_666),
        claimedTokens: new anchor.BN(0),
        startTime: new anchor.BN(startTime),
        cliffMonths: 24,
        totalMonths: 48,
      },
    ];

    totalAmountInit = beneficiaryArray.reduce(
      (sum, b) => sum.add(b.allocatedTokens),
      new anchor.BN(0)
    );
  });

  it("Test Initialize", async () => {
    // Send initialize transaction
    const initTx = await program.methods
      .initialize(
        beneficiaryArray,
        new anchor.BN(totalAmountInit.mul(new BN(10).pow(new BN(decimals)))),
        decimals
      )
      .accounts({
        dataAccount,
        escrowWallet,
        walletToWithdrawFrom: senderATA,
        tokenMint: mintAddress,
        sender: sender,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      // .signers([sender])
      .rpc();

    let accountAfterInit = await program.account.dataAccount.fetch(dataAccount);

    console.log(
      `init TX: https://explorer.solana.com/tx/${initTx}?cluster=custom`
    );

    assert.deepEqual(
      await getTokenBalance(escrowWallet, provider),
      totalAmountInit
    );
    assert.isTrue(
      accountAfterInit.beneficiaries[0].allocatedTokens.eq(
        new anchor.BN(5_000_000_000)
      ),
      "allocatedTokens is not equal to 5_000_000_000"
    );
    assert.equal(
      accountAfterInit.beneficiaries[0].startTime.toNumber(),
      startTime
    );
    assert.equal(accountAfterInit.beneficiaries[0].cliffMonths, 0);
    assert.equal(accountAfterInit.beneficiaries[0].totalMonths, 48);

    assert.isTrue(
      accountAfterInit.beneficiaries[3].allocatedTokens.eq(
        new anchor.BN(166_666_666)
      ),
      "allocatedTokens is not equal to 166_666_666"
    );
    assert.equal(accountAfterInit.beneficiaries[3].cliffMonths, 24);

    _dataAccountAfterInit = dataAccount;
  });

  it("Founder A cannot claim before cliff", async () => {
    await new Promise((r) => setTimeout(r, 6000));

    try {
      await claimCommon(founderA.publicKey, mintAddress, founderAATA, founderA);

      assert.fail("should not be able to claim again");
    } catch (err) {
      assert.equal(err.error?.errorCode?.code, "ClaimNotAllowed");
    }
  });

  async function claimCommon(
    sender: PublicKey,
    token: PublicKey,
    tokenAccout: PublicKey,
    signer: Keypair
  ): Promise<void> {
    await program.methods
      .claim(dataBump, escrowBump)
      .accounts({
        dataAccount,
        escrowWallet,
        sender,
        tokenMint: token,
        walletToDepositTo: tokenAccout,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([signer])
      .rpc();
  }
});
