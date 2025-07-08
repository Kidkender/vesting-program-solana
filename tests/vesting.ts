import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BankrunProvider } from "anchor-bankrun";
import { assert } from "chai";
import { BanksClient, Clock, startAnchor } from "solana-bankrun";
import * as IDL from "../target/idl/vesting.json";
import { Vesting } from "../target/types/vesting";
import {
  BUFFER_SECONDS,
  DECIMALS,
  SECOND_PER_MONTH,
  START_TIME,
  TOTAL_AMOUNT_INIT,
} from "./constant";
import {
  createAndFundSenderATA,
  createMint,
  createPDA,
  createUserAndATA,
  getPassedMonths,
  getTokenBalance,
  sleep,
  toRawUnit,
} from "./utils";

interface BeneficiaryInput {
  key: PublicKey;
  allocatedTokens: BN;
  claimedTokens: BN;
  startTime: BN;
  cliffMonths: number;
  totalMonths: number;
}

describe("vesting with bank run", () => {
  let client: BanksClient;
  let ctx: Awaited<ReturnType<typeof startAnchor>>;
  let provider: BankrunProvider;
  let program: Program<Vesting>;

  let beneficiaryArray: BeneficiaryInput[];

  // Consolidated variables
  let mintAddress: PublicKey;
  let sender: PublicKey;
  let senderATA: PublicKey;
  let dataAccount: PublicKey;
  let dataBump: number;
  let escrowWallet: PublicKey;
  let escrowBump: number;

  // User accounts
  let founderA: Keypair, founderAATA: PublicKey;
  let founderB: Keypair, founderBATA: PublicKey;
  let teamA: Keypair, teamAATA: PublicKey;
  let teamB: Keypair, teamBATA: PublicKey;
  anchor.setProvider(provider);

  let totalVestingAmount: BN;

  // Vesting configurations
  const VESTING_CONFIG = {
    founderA: { amount: 5_000, cliff: 0, duration: 48 },
    founderB: { amount: 5_000, cliff: 0, duration: 12 },
    teamA: { amount: 333.333, cliff: 12, duration: 48 },
    teamB: { amount: 166.667, cliff: 24, duration: 48 },
  };

  before(async () => {
    await setUpTestEnvironment();
    await initializeAccounts();
    await setUpBeneficiaries();
  });

  async function setUpTestEnvironment() {
    ctx = await startAnchor(
      "",
      [{ name: "vesting", programId: new PublicKey(IDL.address) }],
      []
    );

    provider = new BankrunProvider(ctx);
    anchor.setProvider(provider);
    program = new Program<Vesting>(IDL as Vesting, provider);
    client = ctx.banksClient;
  }

  async function initializeAccounts() {
    mintAddress = await createMint(provider, DECIMALS);

    sender = provider.wallet.publicKey;

    senderATA = await createAndFundSenderATA(
      provider,
      mintAddress,
      BigInt(TOTAL_AMOUNT_INIT.toString())
    );

    [dataAccount, dataBump] = await createPDA(
      [Buffer.from("data_account"), mintAddress.toBuffer()],
      program.programId
    );
    [escrowWallet, escrowBump] = await createPDA(
      [Buffer.from("escrow_wallet"), mintAddress.toBuffer()],
      program.programId
    );

    const userPromises = await Promise.all([
      createUserAndATA(ctx, provider, mintAddress),
      createUserAndATA(ctx, provider, mintAddress),
      createUserAndATA(ctx, provider, mintAddress),
      createUserAndATA(ctx, provider, mintAddress),
    ]);

    [
      [founderA, founderAATA],
      [founderB, founderBATA],
      [teamA, teamAATA],
      [teamB, teamBATA],
    ] = userPromises;
  }

  async function setUpBeneficiaries() {
    const configs = [
      { user: founderA, config: VESTING_CONFIG.founderA },
      { user: founderB, config: VESTING_CONFIG.founderB },
      { user: teamA, config: VESTING_CONFIG.teamA },
      { user: teamB, config: VESTING_CONFIG.teamB },
    ];

    beneficiaryArray = configs.map(({ user, config }) => ({
      key: user.publicKey,
      allocatedTokens: toRawUnit(config.amount),
      claimedTokens: new BN(0),
      startTime: new BN(START_TIME),
      cliffMonths: config.cliff,
      totalMonths: config.duration,
    }));

    totalVestingAmount = beneficiaryArray.reduce(
      (sum, b) => sum.add(b.allocatedTokens),
      new BN(0)
    );
  }

  async function warpToMonth(additionalSeconds: bigint): Promise<void> {
    const currentClock = await client.getClock();
    const newTimestamp = BigInt(currentClock.unixTimestamp) + additionalSeconds;

    ctx.setClock(
      new Clock(
        currentClock.slot,
        currentClock.epochStartTimestamp,
        currentClock.epoch,
        currentClock.leaderScheduleEpoch,
        newTimestamp
      )
    );
    const updatedClock = await client.getClock();
    console.log(
      "Current Month: ",
      getPassedMonths(START_TIME, Number(updatedClock.unixTimestamp), 0)
    );
  }

  async function validateClaimAmount(
    beneficiaryIndex: number,
    tokenAccount: PublicKey,
    expectedMonths: number
  ) {
    const balance = await getTokenBalance(tokenAccount, provider);
    const { allocatedTokens, totalMonths, cliffMonths } =
      beneficiaryArray[beneficiaryIndex];

    const claimableMonths = Math.min(expectedMonths, totalMonths - cliffMonths);

    const expectedAmount = allocatedTokens
      .muln(claimableMonths)
      .divn(totalMonths - cliffMonths);

    assert.equal(balance.toString(), expectedAmount.toString());
  }

  async function claimTokens(
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

  it("Test Initialize", async () => {
    sleep();
    await program.methods
      .initialize(beneficiaryArray, totalVestingAmount, DECIMALS)
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

    const escrowWalletBalance = await getTokenBalance(escrowWallet, provider);

    assert.deepEqual(escrowWalletBalance, totalVestingAmount);
    assert.isTrue(
      accountAfterInit.beneficiaries[0].allocatedTokens.eq(toRawUnit(5_000)),
      "allocatedTokens is not equal to 5_000"
    );
    assert.equal(
      accountAfterInit.beneficiaries[0].startTime.toNumber(),
      START_TIME
    );
    assert.equal(accountAfterInit.beneficiaries[0].cliffMonths, 0);
    assert.equal(accountAfterInit.beneficiaries[0].totalMonths, 48);

    assert.isTrue(
      accountAfterInit.beneficiaries[3].allocatedTokens.eq(toRawUnit(166.667)),
      "allocatedTokens is not equal to 166.667"
    );
    assert.equal(accountAfterInit.beneficiaries[3].cliffMonths, 24);

    // _dataAccountAfterInit = dataAccount;
  });

  //  First Month From Start time
  it("Team A cannot claim before cliff", async () => {
    // a month after start time
    sleep();
    await warpToMonth(SECOND_PER_MONTH);
    try {
      await claimTokens(founderA.publicKey, mintAddress, founderAATA, founderA);
      assert.fail("should not be able to claim again");
    } catch (err) {
      assert.equal(err.error?.errorCode?.code, "ClaimNotAllowed");
    }
  });

  // At 6th months
  it("Founder A can claim after 5 months without buffer", async () => {
    sleep();
    await warpToMonth(SECOND_PER_MONTH * BigInt(5));

    await claimTokens(founderA.publicKey, mintAddress, founderAATA, founderA);

    const updatedClock = await client.getClock();
    const currentTime = Number(updatedClock.unixTimestamp);

    const passedMonths = getPassedMonths(
      beneficiaryArray[0].startTime.toNumber(),
      currentTime,
      beneficiaryArray[0].cliffMonths
    );

    console.log("passedMonths", passedMonths);

    await validateClaimAmount(0, founderAATA, passedMonths);
    assert.equal(passedMonths, 5);
  });

  // At 6th months
  it("Founder A can claim 6 months with buffer seconds", async () => {
    sleep();
    // Add 5 seconds buffer to cross month boundary
    await warpToMonth(BigInt(BUFFER_SECONDS));

    await claimTokens(founderA.publicKey, mintAddress, founderAATA, founderA);

    const updatedClock = await client.getClock();
    const currentTime = Number(updatedClock.unixTimestamp);

    const passedMonths = getPassedMonths(
      beneficiaryArray[0].startTime.toNumber(),
      currentTime,
      beneficiaryArray[0].cliffMonths
    );

    await validateClaimAmount(0, founderAATA, passedMonths);
    assert.equal(passedMonths, 6);
  });

  // At 10th months
  it("Admin cannot withdraw before vesting and grace period ends", async () => {
    sleep();
    await warpToMonth(SECOND_PER_MONTH * BigInt(4));

    try {
      await program.methods
        .withdraw(dataBump, escrowBump)
        .accounts({
          dataAccount,
          escrowWallet,
          adminWallet: senderATA,
          admin: sender,
          tokenMint: mintAddress,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Should not be able to withdraw before vesting+grace period");
    } catch (err) {
      assert.equal(err.error?.errorCode?.code, "NoUnclaimedTokens");
    }
  });

  // At 13th months
  it("Team A can claim after cliff period", async () => {
    sleep();
    await warpToMonth(SECOND_PER_MONTH * BigInt(3));

    await claimTokens(teamA.publicKey, mintAddress, teamAATA, teamA);

    const currentClock = await client.getClock();
    const passedMonths = getPassedMonths(
      beneficiaryArray[2].startTime.toNumber(),
      Number(currentClock.unixTimestamp),
      beneficiaryArray[2].cliffMonths
    );

    await validateClaimAmount(2, teamAATA, passedMonths);
    assert.isAtLeast(passedMonths, 1);
  });

  // At 13th months
  it("Founder B can done claim", async () => {
    sleep();
    await claimTokens(founderB.publicKey, mintAddress, founderBATA, founderB);

    const currentClock = await client.getClock();
    const passedMonths = getPassedMonths(
      beneficiaryArray[1].startTime.toNumber(),
      Number(currentClock.unixTimestamp),
      beneficiaryArray[1].cliffMonths
    );

    await validateClaimAmount(1, founderBATA, passedMonths);
    assert.isAtLeast(passedMonths, 12);
  });

  // At month: 15
  it("Cannot claim more than vested amount", async () => {
    sleep();
    await warpToMonth(SECOND_PER_MONTH * BigInt(2));

    try {
      await claimTokens(founderB.publicKey, mintAddress, founderBATA, founderB);
      assert.fail("Should not be able to claim more than vested amount");
    } catch (err) {
      assert.equal(err.error?.errorCode?.code, "ClaimNotAllowed");
    }
  });

  it("Non-beneficiary cannot claim (BeneficiaryNotFound)", async () => {
    sleep();
    const [stranger, strangerATA] = await createUserAndATA(
      ctx,
      provider,
      mintAddress
    );
    try {
      await claimTokens(stranger.publicKey, mintAddress, strangerATA, stranger);
      assert.fail("Stranger should not be able to claim");
    } catch (err) {
      assert.equal(err.error?.errorCode?.code, "BeneficiaryNotFound");
    }
  });

  it("Non-admin cannot withdraw (UnauthorizedAdmin)", async () => {
    sleep();
    try {
      await program.methods
        .withdraw(dataBump, escrowBump)
        .accounts({
          dataAccount,
          escrowWallet,
          adminWallet: founderAATA,
          admin: founderA.publicKey,
          tokenMint: mintAddress,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([founderA])
        .rpc();
      assert.fail("Non-admin should not be able to withdraw");
    } catch (err) {
      assert.equal(err.error?.errorCode?.code, "UnauthorizedAdmin");
    }
  });
});
