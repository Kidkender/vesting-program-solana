# Vesting Program (Solana + Anchor)

## Overview

This project implements a token vesting smart contract on Solana using the Anchor framework. It allows an admin to set up vesting schedules for multiple beneficiaries, supporting cliff periods, custom start times, and flexible vesting logic. The contract ensures tokens are securely held in escrow and released according to the vesting schedule.

## Features

- Multiple beneficiaries per vesting schedule
- Configurable cliff and vesting periods (in months)
- Admin-controlled initialization and withdrawal
- SPL token support
- Secure escrow wallet (PDA)
- Claiming logic enforces cliff and vesting rules
- Grace period for admin withdrawal of unclaimed tokens

## Directory Structure

```
programs/vesting/         # Rust smart contract (Anchor)
tests/vesting.ts          # Anchor Mocha/TypeScript tests
app/                      # (Optional) Frontend or scripts
migrations/               # Anchor migration scripts
```

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
npm install
# Build the program
anchor build
# Run local validator (in another terminal)
solana-test-validator
# Deploy program to localnet
anchor deploy
# Run tests
anchor test
```

## Testing Notes

- Tests are written in TypeScript using Mocha/Chai and Anchor's provider.
- For vesting/claim logic, tests may use setTimeout to simulate time passing, since Solana localnet does not always support warp slot/block time.
- See `tests/vesting.ts` for usage examples.

## Key Files

- `programs/vesting/src/lib.rs` — Main smart contract logic
- `tests/vesting.ts` — Test suite for vesting scenarios
- `utils.ts` — Helper functions for test setup

## Example Usage

- Initialize vesting for multiple users with different cliffs and vesting periods
- Claim tokens after cliff/vesting period
- Admin withdraws unclaimed tokens after grace period

## License

MIT
