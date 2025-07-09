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
  let amountTeamBFirstMonths: BN;

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

  it("Test validate input", async () => {
    sleep();
    const [stranger, strangerATA] = await createUserAndATA(
      ctx,
      provider,
      mintAddress
    );

    const updateBeneficiaries = [...beneficiaryArray];
    updateBeneficiaries.push({
      key: stranger.publicKey,
      allocatedTokens: toRawUnit(0),
      claimedTokens: new BN(0),
      cliffMonths: 13,
      totalMonths: 24,
      startTime: new BN(START_TIME),
    });
    try {
      await program.methods
        .initialize(updateBeneficiaries, totalVestingAmount, DECIMALS)
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
      assert.fail("should not be able to initialize");
    } catch (err) {
      assert.equal(err.error?.errorCode?.code, "InvalidAllocation");
    }
  });

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

  // At month: 1
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

  // At month: 16
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

    await validateClaimAmount(0, founderAATA, passedMonths);
    assert.equal(passedMonths, 5);
  });

  // At month: 16
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

  // At month: 10
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

  // At month: 10
  it("Founder B can claim at 10th month", async () => {
    sleep();
    await claimTokens(founderB.publicKey, mintAddress, founderBATA, founderB);

    const currentClock = await client.getClock();
    const passedMonths = getPassedMonths(
      beneficiaryArray[1].startTime.toNumber(),
      Number(currentClock.unixTimestamp),
      beneficiaryArray[1].cliffMonths
    );

    await validateClaimAmount(1, founderBATA, passedMonths);
    assert.isAtLeast(passedMonths, 10);
  });

  // At month: 13
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

  // At month: 15
  it("Non-beneficiary cannot claim (BeneficiaryNotFound)", async () => {
    sleep();
    await warpToMonth(SECOND_PER_MONTH * BigInt(2));
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

  // At month: 15
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

  // At month: 18
  it("Admin can withdraw balance of founder B after end grace period", async () => {
    sleep();
    await warpToMonth(SECOND_PER_MONTH * BigInt(3));

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
    const adminAmount = await getTokenBalance(senderATA, provider);
    const remainAmount = TOTAL_AMOUNT_INIT.sub(totalVestingAmount); // 15000 - 10500 = 4500
    const founderBAmount = await getTokenBalance(founderBATA, provider);
    const unclaimed = beneficiaryArray[1].allocatedTokens.sub(founderBAmount);
    const remainAddUnclaimed = remainAmount.add(unclaimed);
    assert.equal(remainAddUnclaimed.toString(), adminAmount.toString());
  });

  // At month: 18
  it("Founder B cannot claim more than vested amount", async () => {
    sleep();
    // await warpToMonth(SECOND_PER_MONTH * BigInt(2));

    try {
      await claimTokens(founderB.publicKey, mintAddress, founderBATA, founderB);
      assert.fail("Should not be able to claim more than vested amount");
    } catch (err) {
      assert.equal(err.error?.errorCode?.code, "ClaimNotAllowed");
    }
  });

  // At month: 25
  it("team B can claim first at 25th months", async () => {
    sleep();
    warpToMonth(SECOND_PER_MONTH * BigInt(7));
    await claimTokens(teamB.publicKey, mintAddress, teamBATA, teamB);

    const currentClock = await client.getClock();
    const passedMonths = getPassedMonths(
      beneficiaryArray[3].startTime.toNumber(),
      Number(currentClock.unixTimestamp),
      beneficiaryArray[3].cliffMonths
    );

    await validateClaimAmount(3, teamBATA, passedMonths);
    amountTeamBFirstMonths = await getTokenBalance(teamBATA, provider);

    assert.isAtLeast(passedMonths, 1);
  });

  // At month: 45
  it("team B must claim 21 months at months 45", async () => {
    sleep();
    warpToMonth(SECOND_PER_MONTH * BigInt(20));
    await claimTokens(teamB.publicKey, mintAddress, teamBATA, teamB);

    const currentClock = await client.getClock();
    const passedMonths = getPassedMonths(
      beneficiaryArray[3].startTime.toNumber(),
      Number(currentClock.unixTimestamp),
      beneficiaryArray[3].cliffMonths
    );
    const currentAmount = await getTokenBalance(teamBATA, provider);

    await validateClaimAmount(3, teamBATA, passedMonths);
    const numMonths = currentAmount.div(new BN(amountTeamBFirstMonths));
    assert.isAtLeast(passedMonths, 21);
    assert.equal(numMonths.toString(), "21");
  });

  // At month: 45
  it("team B cannot continue claim at months 45", async () => {
    sleep();

    try {
      await claimTokens(teamB.publicKey, mintAddress, teamBATA, teamB);
      assert.fail("Should not be able to claim more than vested amount");
    } catch (err) {
      assert.equal(err.error?.errorCode?.code, "ClaimNotAllowed");
    }
  });
});
