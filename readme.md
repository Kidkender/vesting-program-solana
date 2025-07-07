# Vesting Program (Solana + Anchor)

## Overview

This project implements a secure, production-ready token vesting smart contract on Solana using the Anchor framework. It supports multiple beneficiaries, flexible cliff and vesting periods, and robust admin controls. The contract is designed for auditability, security, and extensibility.

---

## Features

- **Multiple Beneficiaries:** Each vesting schedule can include up to 50 beneficiaries, each with custom allocation, cliff, and vesting period.
- **Configurable Cliff & Vesting:** Supports per-beneficiary cliff (in months), total vesting duration, and custom start time.
- **Admin Controls:** Only the admin can initialize, update, or withdraw unclaimed tokens.
- **SPL Token Support:** Works with any SPL token mint.
- **Secure Escrow (PDA):** Tokens are held in a program-derived escrow wallet, only released by program logic.
- **Claiming Logic:** Enforces cliff, vesting, and precision rules. Prevents over-claiming and double-claiming.
- **Grace Period:** After vesting ends, a 3-month grace period is enforced before admin can withdraw unclaimed tokens.
- **Comprehensive Error Codes:** All failure cases are explicit and auditable.
- **Anchor Best Practices:** Uses Anchor macros, constraints, events, and error handling for maximum safety.

---

## Directory Structure

```
programs/vesting/         # Rust smart contract (Anchor)
  src/lib.rs              # Main contract logic
tests/                    # TypeScript/Bankrun/Anchor test suite
  constants.ts            # Constant common
  vesting.ts              # Standard Anchor tests
  utils.ts                # Test helpers
migrations/               # Anchor migration scripts
app/                      # (Optional) Frontend/scripts
```

---

## Getting Started

### Prerequisites

- Node.js >= 16
- Yarn or npm
- Rust + Cargo
- Solana CLI
- Anchor CLI (`cargo install --git https://github.com/coral-xyz/anchor anchor-cli --locked`)

### Build & Test

```bash
# Install dependencies
yarn install
# Build the program
anchor build
# Run local validator (in another terminal)
solana-test-validator
# Deploy program to localnet
anchor deploy
# Run tests (standard)
anchor test
# Run tests with bankrun (for time-warped vesting logic)
anchor run test_debug
```

---

## Security & Audit Notes

- All account constraints, PDAs, and authority checks are enforced on-chain.
- No reentrancy, overflow, or double-claim vulnerabilities.
- All math uses saturating/checked arithmetic.
- Only admin can initialize or withdraw unclaimed tokens.
- Beneficiaries cannot claim before cliff or after full vesting.
- Admin can only withdraw after vesting + grace period, and only unclaimed tokens.
- All error codes are explicit and mapped to program logic.
- Test suite covers: claim, cliff, over-claim, unauthorized actions, admin withdraw, edge cases, and precision loss.

---

## Key Files

- `programs/vesting/src/lib.rs` — Main smart contract logic (Anchor, Rust)
- `tests/contants.ts` — Constant common
- `tests/vesting.ts` — Standard Anchor test suite, time-warp, edge cases, security
- `tests/utils.ts` — Helper functions for test setup

---

## Example Usage

### 1. Initialize Vesting

```typescript
await program.methods
  .initialize(beneficiaryArray, totalVestingAmount, decimals)
  .accounts({
    dataAccount,
    escrowWallet,
    walletToWithdrawFrom: senderATA,
    tokenMint: mintAddress,
    sender,
    systemProgram: anchor.web3.SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc();
```

### 2. Claim Tokens (by beneficiary)

```typescript
await program.methods
  .claim(dataBump, escrowBump)
  .accounts({
    dataAccount,
    escrowWallet,
    sender: beneficiary.publicKey,
    tokenMint: mintAddress,
    walletToDepositTo: beneficiaryATA,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([beneficiary])
  .rpc();
```

### 3. Admin Withdraw Unclaimed Tokens (after vesting + grace period)

```typescript
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
```

---

## Testing & Coverage

- All core logic is covered by TypeScript tests (Mocha/Chai/Bankrun).
- Edge cases: claim before/after cliff, over-claim, unauthorized actions, admin withdraw, precision loss, and more.
- See `tests/bankrun.ts` for advanced time-warped scenarios.

---

## License

MIT
