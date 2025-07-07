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
} from "././constant";
import {
  createAndFundSenderATA,
  createMint,
  createPDA,
  createUserAndATA,
  getPassedMonths,
  getTokenBalance,
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

  let totalVestingAmount;

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
  }

  it("Test Initialize", async () => {
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

  it("Team A cannot claim before cliff", async () => {
    // a month after start time

    await warpToMonth(SECOND_PER_MONTH);

    try {
      await claimCommon(founderA.publicKey, mintAddress, founderAATA, founderA);
      assert.fail("should not be able to claim again");
    } catch (err) {
      assert.equal(err.error?.errorCode?.code, "ClaimNotAllowed");
    }
  });

  it("Founder A can claim after 5 months without buffer", async () => {
    await warpToMonth(SECOND_PER_MONTH * BigInt(5));

    await claimCommon(founderA.publicKey, mintAddress, founderAATA, founderA);
    const balanceAfter = await getTokenBalance(founderAATA, provider);

    const updatedClock = await client.getClock();
    const currentTime = Number(updatedClock.unixTimestamp);
    console.log("currentTime", currentTime);

    const passedMonths = getPassedMonths(
      beneficiaryArray[0].startTime.toNumber(),
      currentTime
    );

    console.log("passedMonths", passedMonths);

    const balanceExpected = beneficiaryArray[0].allocatedTokens
      .muln(passedMonths)
      .divn(beneficiaryArray[0].totalMonths);

    assert.equal(balanceAfter.toString(), balanceExpected.toString());
    assert.equal(passedMonths, 5);
  });

  it("Founder A can claim 6 months with buffer seconds", async () => {
    // Add 5 seconds buffer to cross month boundary
    await warpToMonth(BigInt(BUFFER_SECONDS));

    await claimCommon(founderA.publicKey, mintAddress, founderAATA, founderA);
    const balanceAfter = await getTokenBalance(founderAATA, provider);

    const updatedClock = await client.getClock();
    const currentTime = Number(updatedClock.unixTimestamp);
    console.log("currentTime", currentTime);

    const passedMonths = getPassedMonths(
      beneficiaryArray[0].startTime.toNumber(),
      currentTime
    );

    console.log("passedMonths", passedMonths);

    const balanceExpected = beneficiaryArray[0].allocatedTokens
      .muln(passedMonths)
      .divn(beneficiaryArray[0].totalMonths);

    assert.equal(balanceAfter.toString(), balanceExpected.toString());
    assert.equal(passedMonths, 6);
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
