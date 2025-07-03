import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { createPDA, createUserAndATA, createMint, getTokenBalance, createAndFundSenderATA } from "./utils";
import { Vesting } from "../target/types/vesting";
import { assert } from "chai";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BN } from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";

describe("vesting", () => {

    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.Vesting as Program<Vesting>;

    let mintAddress, sender, senderATA, dataAccount, dataBump, escrowWallet, escrowBump, beneficiaryArray ;

    let founderA, founderB, founderAATA, founderBATA, teamA, teamAATA, teamB, teamBATA;
    let _dataAccountAfterInit;
    const now = Math.floor(Date.now() / 1000);
    const secondsPerMonth = 30 * 24 * 60 * 60;
    const oneYearAgo = now - 12 * secondsPerMonth;
    const fourYearsAgo = now - (48 * secondsPerMonth);
    let totalAmountInit = 0;

    const decimals = 6;
    before(async () => {
        mintAddress = await createMint(provider, decimals);
        sender = provider.wallet.publicKey;
        senderATA = await createAndFundSenderATA(provider, mintAddress, 15_000_000_000, decimals);

        [dataAccount, dataBump] = await createPDA([Buffer.from("data_account"), mintAddress.toBuffer()], program.programId);
        [escrowWallet, escrowBump] = await createPDA([Buffer.from("escrow_wallet"), mintAddress.toBuffer()], program.programId);

        [founderA, founderAATA] = await createUserAndATA(provider, mintAddress );
        [founderB, founderBATA] = await createUserAndATA(provider, mintAddress);
        [teamA, teamAATA] = await createUserAndATA(provider, mintAddress, ); 
        [teamB, teamBATA] = await createUserAndATA(provider, mintAddress, );

        beneficiaryArray = [
            {
                key: founderA.publicKey,
                allocatedTokens: new anchor.BN(5_000_000_000), // 5B
                claimedTokens: new anchor.BN(0),
                startTime: new BN( oneYearAgo ),
                cliffMonths: 48,
                totalMonths: 48,
            },
            {
                key: founderB.publicKey,
                allocatedTokens: new anchor.BN(5_000_000_000),
                claimedTokens: new anchor.BN(0),
                startTime: new BN(oneYearAgo),
                cliffMonths: 12,
                totalMonths: 12,
            },
            {
                key: teamA.publicKey,
                allocatedTokens: new anchor.BN(333_333_333),
                claimedTokens: new anchor.BN(0),
                startTime: new anchor.BN(oneYearAgo),
                cliffMonths: 12,
                totalMonths: 48,
            },
            {
                key: teamB.publicKey,
                allocatedTokens: new anchor.BN(166_666_666),
                claimedTokens: new anchor.BN(0),
                startTime: new anchor.BN(oneYearAgo),
                cliffMonths: 24,
                totalMonths: 48,
            }
        ]

        totalAmountInit = beneficiaryArray.reduce((sum, b) => sum.add(b.allocatedTokens), new anchor.BN(0));
    });

    it("Test Initialize", async () => {
        // Send initialize transaction  
        const initTx = await program.methods.initialize(beneficiaryArray, new anchor.BN(totalAmountInit), decimals).accounts({
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

        console.log(`init TX: https://explorer.solana.com/tx/${initTx}?cluster=custom`)

            assert.equal(await getTokenBalance(escrowWallet, provider), totalAmountInit);
        assert.isTrue(
            accountAfterInit.beneficiaries[0].allocatedTokens.eq(new anchor.BN(5_000_000_000)),
            "allocatedTokens is not equal to 5_000_000_000"
        );
        assert.equal(accountAfterInit.beneficiaries[0].startTime.toNumber(), oneYearAgo);
        assert.equal(accountAfterInit.beneficiaries[0].cliffMonths, 48);
        assert.equal(accountAfterInit.beneficiaries[0].totalMonths, 48);


        assert.isTrue(
            accountAfterInit.beneficiaries[3].allocatedTokens.eq(new anchor.BN(166_666_666)),
            "allocatedTokens is not equal to 166_666_666"
        );
        assert.equal(accountAfterInit.beneficiaries[3].cliffMonths, 24);

        _dataAccountAfterInit = dataAccount;

    });

    it("Founder A cannot claim after 1 year", async () => {
        try {
            await claimCommon(founderA.publicKey, mintAddress, founderAATA, founderA);
            assert.fail("Founder A should not be able to claim yet");
        } catch(err) {
            const code = err.error?.errorCode?.code;
            assert.equal(code, "CliffNotReached", "Expected CliffNotReached error");
        }
    })

    it("Founder B can claim full after 1 year", async () => {

        await claimCommon(founderB.publicKey, mintAddress, founderBATA, founderB);

        const balance = await getTokenBalance(founderBATA, provider);
        assert.equal((balance).toString(), "5000000000", "Founder B should claim after 1 year");
    })


    it("Founder A can claim full after 4 years", async () => {
        const clock = await provider.connection.getBlockTime(await provider.connection.getSlot());
        console.log("Current Solana Time:", clock);

        const founderAStartTime = new BN(fourYearsAgo);
        const newMint = await createMint(provider, decimals);
        const senderATA = await createAndFundSenderATA(provider, newMint, 5_000_000_000, decimals);
        const [dataAccount, dataBump] = await createPDA([Buffer.from("data_account"), newMint.toBuffer()], program.programId);
        const [escrowWallet, escrowBump] = await createPDA([Buffer.from("escrow_wallet"), newMint.toBuffer()], program.programId);
        const [founderA, founderAATA] = await createUserAndATA(provider, newMint);

        const singleFounder = [{
            key: founderA.publicKey,
            allocatedTokens: new BN(5_000_000_000),
            claimedTokens: new BN(0),
            startTime: founderAStartTime,
            cliffMonths: 48,
            totalMonths: 48
        }];

        await program.methods
        .initialize(singleFounder, new BN(5_000_000_000), decimals)
        .accounts({
            dataAccount,
            escrowWallet,
            walletToWithdrawFrom: senderATA,
            tokenMint: newMint,
            sender: provider.wallet.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

        const userBalanceBefore = await getTokenBalance(founderAATA, provider);

        await program.methods
        .claim(dataBump, escrowBump)
        .accounts({
            dataAccount,
            escrowWallet,
            sender: founderA.publicKey,
            walletToDepositTo: founderAATA,
            tokenMint: newMint,
            tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([founderA])
        .rpc();

        const userBalanceAfter = await getTokenBalance(founderAATA, provider);

        assert.equal(
            userBalanceAfter - userBalanceBefore,
            5_000_000_000,
            "Founder A should receive full tokens after 4 years"
        );
    });


    it("Founder B cannot over claim after full vesting", async () => {
        try {

            await claimCommon(founderB.publicKey, mintAddress, founderBATA, founderB);
            assert.fail("should not be able to claim again");

        } catch (err) {
            assert.equal(err.error?.errorCode?.code, "ClaimNotAllowed");
        }
    })

    it("Team A can claim 25% after 1 year cliff", async () => {
        await claimCommon(teamA.publicKey, mintAddress, teamAATA, teamA);
        const balance = await getTokenBalance(teamAATA, provider);
        assert.equal(balance.toString(), Math.floor(333_333_333/4).toString(), "Team A should claim after 1 year cliff");
    });

    it("Stranger cannot claim tokens", async () => {
        const [stranger, strangerATA] = await createUserAndATA(provider, mintAddress);

        try {
            await claimCommon(stranger.publicKey, mintAddress, strangerATA, stranger);
            assert.fail("Stranger should not be able to claim");
        } catch(err) {
            assert.equal(err.error?.errorCode?.code, "BeneficiaryNotFound");
        }
    })


    async function claimCommon(sender: PublicKey, token: PublicKey, tokenAccout: PublicKey, signer: Keypair ): Promise<void> {
        await program.methods.claim(dataBump,escrowBump).accounts({
            dataAccount, 
            escrowWallet,
            sender,
            tokenMint: token,
            walletToDepositTo: tokenAccout,
            tokenProgram: TOKEN_PROGRAM_ID
        }).signers([signer]).rpc();

    }
})

