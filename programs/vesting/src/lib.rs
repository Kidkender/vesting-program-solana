#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub const SECONDS_PER_MONTH: i64 = 2_629_776; // Average seconds in a month (30.44 days)
pub const GRACE_PERIOD: i64 = 6 * SECONDS_PER_MONTH; // 6 months grace period
pub const MAX_START_DELAY: i64 = 365 * 24 * 60 * 60; // Maximum delay for start time (1 year in seconds)


declare_id!("2Ut9RKeaqo895gVTEZ6fgG9WJ2sZAPfws5Hp3WGkcAg8");

#[program]
pub mod vesting {

    use super::*;

    /// Initializes a vesting schedule for multiple beneficiaries.
    /// - Only the admin (sender) can initialize or update.
    /// - Validates input: beneficiaries, total tokens, start time, etc.
    /// - Transfers tokens from admin's wallet to the escrow wallet.
    /// - Stores vesting info in DataAccount.
    pub fn initialize(
        ctx: Context<Initialize>, 
        beneficiaries: Vec<Beneficiary>, 
        amount: u64, 
        decimals: u8,
    ) -> Result<()> {
        let data_account = &mut ctx.accounts.data_account;
        let now = Clock::get()?.unix_timestamp;
        
        if data_account.authority == Pubkey::default() {
            data_account.authority = ctx.accounts.sender.to_account_info().key();
        } else {
            require!(
                data_account.authority == ctx.accounts.sender.key(),
                VestingError::UnauthorizedAdmin
            );
        }

        require!(!beneficiaries.is_empty(), VestingError::NoBeneficiaries);
        require!(beneficiaries.len() <= 50, VestingError::TooManyBeneficiaries);
        require!(amount > 0, VestingError::InvalidAmount);
        require!(decimals <= 9, VestingError::InvalidDecimals);

        let mut seen = std::collections::HashSet::new();

        for b in beneficiaries.iter() {
            require!(b.total_months >= 1, VestingError::InvalidVestingPeriod);
            require!(b.cliff_months <= 48, VestingError::CliffTooLong);
            require!(b.cliff_months < b.total_months, VestingError::InvalidCliffPeriod);
            require!(b.allocated_tokens > 0, VestingError::InvalidAllocation);
            require!(b.start_time >= now, VestingError::InvalidStartTime);
            require!(
                b.start_time <= now + MAX_START_DELAY,
                VestingError::StartTimeTooFar
            );

            if b.cliff_months > 0 {
                // Only allow vesting with total time divisible by cliff time
                require!(b.total_months % b.cliff_months == 0, VestingError::InvalidVestingConfig);
            }
            
            require!(seen.insert(b.key), VestingError::DuplicateBeneficiary);            
        }

        let mut total_allocated = 0u64;

        for b in beneficiaries.iter() {
            total_allocated = total_allocated
                .checked_add(b.allocated_tokens)
                .ok_or(VestingError::MathOverflow)?;
        }

        data_account.beneficiaries = beneficiaries;
        data_account.token_amount = amount;
        data_account.decimals = decimals;
        data_account.escrow_wallet = ctx.accounts.escrow_wallet.to_account_info().key();
        data_account.token_mint = ctx.accounts.token_mint.to_account_info().key();
        require!(total_allocated <= amount, VestingError::OverAllocation);

        let transfer_instruction = Transfer{ 
            from: ctx.accounts.wallet_to_withdraw_from.to_account_info(),
            to: ctx.accounts.escrow_wallet.to_account_info(),
            authority: ctx.accounts.sender.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), transfer_instruction);   

        let transfer_amount = data_account.token_amount;

        require!(ctx.accounts.wallet_to_withdraw_from.amount >= transfer_amount, VestingError::InsufficientBalance);

        token::transfer(cpi_ctx, transfer_amount)?;

        emit!(VestingInitialized {
            admin: ctx.accounts.sender.key(),
            token_mint: ctx.accounts.token_mint.key(),
            total_amount: amount,
            beneficiaries_count: data_account.beneficiaries.len() as u32,
        });

        Ok(())
    }

    /// Allows a beneficiary to claim their unlocked tokens according to the vesting schedule.
    /// - Calculates elapsed months and checks cliff.
    /// - Computes claimable tokens and transfers from escrow to beneficiary.
    /// - Updates claimed token amount.
    pub fn claim(ctx: Context<Claim>, data_bump: u8, escrow_bump: u8) -> Result<()> {
        let sender = &ctx.accounts.sender;
        let escrow_wallet = &ctx.accounts.escrow_wallet;
        let data_account = &mut ctx.accounts.data_account;
        let token_program = &ctx.accounts.token_program;
        let token_mint_key = &ctx.accounts.token_mint.key();
        let beneficiaries_ata = &ctx.accounts.wallet_to_deposit_to;

        let (expected_escrow_pda, expected_escrow_bump) = Pubkey::find_program_address(
            &[b"escrow_wallet".as_ref(), token_mint_key.as_ref()],
            ctx.program_id
        );

        require!(ctx.accounts.escrow_wallet.key() == expected_escrow_pda,
            VestingError::InvalidEscrowWallet
        );

        require!(escrow_bump == expected_escrow_bump,         VestingError::InvalidEscrowBump);

        let index = data_account
            .beneficiaries
            .iter()
            .position(|b| b.key == *sender.key)
            .ok_or(VestingError::BeneficiaryNotFound)?;

        let beneficiary = data_account.beneficiaries[index];

        let now = Clock::get()?.unix_timestamp;

        let cliff_months = beneficiary.cliff_months as u64;
        let total_months = beneficiary.total_months as u64;                                     
        let vesting_month = total_months - cliff_months;

        require!(vesting_month > 0, VestingError::InvalidVestingConfig);
 
        let months_elapsed = if now >= beneficiary.start_time {
            let time_diff = now.saturating_sub(beneficiary.start_time);
            let calculated_months = time_diff.checked_div(SECONDS_PER_MONTH).ok_or(VestingError::MathOverflow)?;
            
            // Safety cap: use actual beneficiary's total_months + small buffer
            let safety_cap = (beneficiary.total_months as i64).saturating_add(120);
            std::cmp::min(calculated_months, safety_cap) as u64
        } else {
            0u64
        };

        if months_elapsed < cliff_months {
            return err!(VestingError::CliffNotReached);
        }

        let months_vested = std::cmp::min(months_elapsed - cliff_months, vesting_month);

        let allocated_raw = beneficiary.allocated_tokens as u128;
          
        let claimed_raw =  beneficiary.claimed_tokens as u128;
                
        let unlocked = if months_vested >= vesting_month {
            allocated_raw
        } else {
            allocated_raw
                .checked_mul(months_vested as u128)
                .ok_or(VestingError::MathOverflow)?
                .checked_div(vesting_month as u128)
                .ok_or(VestingError::MathOverflow)?
        };

        let claimable = unlocked.saturating_sub(claimed_raw );

        require!(claimable > 0, VestingError::ClaimNotAllowed);

        let seeds = &["data_account".as_bytes(), token_mint_key.as_ref(), &[data_bump]];
        let signer_seeds = &[&seeds[..]];

        let transfer_instruction = Transfer {
            from: escrow_wallet.to_account_info(),
            to: beneficiaries_ata.to_account_info(),
            authority: data_account.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            token_program.to_account_info(), 
            transfer_instruction, 
            signer_seeds
        );

        let transfer_amount = u64::try_from(claimable).map_err(|_| VestingError::MathOverflow)?;

        require!(escrow_wallet.amount >= transfer_amount, VestingError::InsufficientBalance);
        
        data_account.beneficiaries[index].claimed_tokens += transfer_amount ;
        
        token::transfer(cpi_ctx, transfer_amount)?;

        emit!(TokensClaimed {
            beneficiary: sender.key(),
            amount: transfer_amount,
            timestamp: now,
        });

        Ok(())
    }

    /// Allows the admin to withdraw unclaimed tokens after the vesting period plus a grace period (3 months).
    /// - Sums up all unclaimed tokens for expired beneficiaries.
    /// - Transfers these tokens back to the admin's wallet.
    /// - Updates beneficiary state.
    pub fn withdraw(
        ctx: Context<WithdrawUnclaimed>,
        data_bump: u8,
        escrow_bump: u8,
    ) -> Result<()> {
        let data_account = &mut ctx.accounts.data_account;
        let escrow_wallet = &ctx.accounts.escrow_wallet;
        let admin_wallet = &ctx.accounts.admin_wallet;
        let token_mint_key = &ctx.accounts.token_mint.key();

        let (expected_escrow_pda, expected_escrow_bump) = Pubkey::find_program_address(
            &[b"escrow_wallet".as_ref(), token_mint_key.as_ref()],
            ctx.program_id
        );
        
        require!(
            ctx.accounts.escrow_wallet.key() == expected_escrow_pda,
            VestingError::InvalidEscrowWallet
        );
        
        require!(
            escrow_bump == expected_escrow_bump,
            VestingError::InvalidEscrowBump
        );

        require!(data_account.authority == ctx.accounts.admin.key(), VestingError::UnauthorizedAdmin);
        let now = Clock::get()?.unix_timestamp;

        let mut total_unclaimed = 0u64;
        let mut _beneficiaries_processed = 0u32;

        for i in 0..data_account.beneficiaries.len() {
            let beneficiary = &data_account.beneficiaries[i];

            // Calculate when beneficiary can actually start claiming (after cliff)
            let cliff_end_time = beneficiary.start_time + (beneficiary.cliff_months as i64 * SECONDS_PER_MONTH);
            // Calculate when full vesting period ends
            let total_vesting_period = beneficiary.start_time + (beneficiary.total_months as i64 * SECONDS_PER_MONTH);

            let earliest_withdraw_time = std::cmp::max(cliff_end_time + GRACE_PERIOD, total_vesting_period + GRACE_PERIOD);

            if now > earliest_withdraw_time {
                let unclaimed_tokens = beneficiary.allocated_tokens
                    .saturating_sub(beneficiary.claimed_tokens);

                if unclaimed_tokens > 0 {
                    total_unclaimed += unclaimed_tokens;
                    data_account.beneficiaries[i].claimed_tokens = beneficiary.allocated_tokens;
                    _beneficiaries_processed += 1;
                }
            }
        }

        require!(total_unclaimed > 0, VestingError::NoUnclaimedTokens);
        
        require!(
            escrow_wallet.amount >= total_unclaimed,
            VestingError::InsufficientBalance
        );
        let token_mint_key = &ctx.accounts.token_mint.key();
        let seeds = &["data_account".as_bytes(), token_mint_key.as_ref(), &[data_bump]];
        let signer_seeds = &[&seeds[..]];

        let transfer_instruction = Transfer {
            from: escrow_wallet.to_account_info(),
            to: admin_wallet.to_account_info(),
            authority: data_account.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_instruction,
            signer_seeds
        );

        token::transfer(cpi_ctx, total_unclaimed)?;
        emit!(AllUnclaimedWithdrawn {
           admin: ctx.accounts.admin.key(),
           total_amount: total_unclaimed,
           beneficiaries_processed: _beneficiaries_processed,
           timestamp: now,
    });

        Ok(())
    }

}

// Macro to calculate the space required for the DataAccount based on the number of beneficiaries.
macro_rules! calculate_vesting_space {
    ($beneficiaries_count: expr) => {
        8 + 8 + 32 + 32 + 32 + 1 + (4 + $beneficiaries_count * (32 + 8 + 8 + 8 + 1 + 1) + 1)
    };
}

/// Accounts required for the `initialize` instruction.
/// - data_account: Stores vesting state.
/// - escrow_wallet: Holds tokens for vesting.
/// - wallet_to_withdraw_from: Admin's wallet to fund escrow.
/// - sender: The admin.
/// - token_mint: The SPL token mint.
/// - system_program, token_program: System and token programs.
#[derive(Accounts)]
#[instruction(beneficiaries: Vec<Beneficiary>, amount: u64, decimals: u8)]
pub struct Initialize<'info> {
    #[account(init,
        payer = sender,
        space = calculate_vesting_space!(beneficiaries.len()),
        seeds = [b"data_account", token_mint.key().as_ref()],
        bump
    )]
    pub data_account: Account<'info, DataAccount>,

    #[account(init, 
        payer = sender, 
        seeds = [b"escrow_wallet".as_ref(), token_mint.key().as_ref()],
        bump,
        token::mint=token_mint,
        token::authority=data_account,
    )]
    pub escrow_wallet: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint=wallet_to_withdraw_from.owner == sender.key(),
        constraint=wallet_to_withdraw_from.mint == token_mint.key()
    )]
    pub wallet_to_withdraw_from: Account<'info, TokenAccount>,

    pub token_mint: Account<'info, Mint>,

    #[account(mut)]
    pub sender: Signer<'info>,

    pub system_program: Program<'info, System>,

    pub token_program: Program<'info, Token>
}


#[derive(Accounts)]
#[instruction(data_bump: u8, wallet_bump: u8)]
pub struct Claim<'info> {
    #[account(
        mut, 
        seeds = [b"data_account", token_mint.key().as_ref()],
        bump= data_bump
    )]
    pub data_account: Account<'info, DataAccount>,

    #[account(
        mut,
        seeds= [b"escrow_wallet".as_ref(), token_mint.key().as_ref()],
        bump=wallet_bump,
    )]
    pub escrow_wallet: Account<'info, TokenAccount>,

    #[account(mut)]
    pub sender: Signer<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = sender,
        associated_token::mint = token_mint,
        associated_token::authority = sender
    )]
    pub wallet_to_deposit_to: Account<'info, TokenAccount>,

    pub associated_token_program: Program<'info, AssociatedToken>,

    pub token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,
}

/// Represents a single beneficiary's vesting configuration.
/// - key: Beneficiary's address.
/// - allocated_tokens: Total tokens allocated.
/// - claimed_tokens: Tokens already claimed.
/// - start_time: Vesting start timestamp.
/// - cliff_months: Number of cliff months.
/// - total_months: Total vesting duration in months.
#[derive(Default, Copy, Clone, AnchorSerialize, AnchorDeserialize)]
pub struct Beneficiary {
    pub key: Pubkey,
    pub allocated_tokens: u64,
    pub claimed_tokens: u64,
    pub start_time: i64, 
    pub cliff_months: u8,
    pub total_months: u8,
}

/// Main account storing all vesting program state.
/// - token_amount: Total tokens for vesting.
/// - authority: Admin address.
/// - escrow_wallet: Escrow wallet address.
/// - token_mint: SPL token mint.
/// - beneficiaries: List of all beneficiaries.
/// - decimals: Token decimals.
#[account]
#[derive(Default)]
pub struct DataAccount {
    // Space in bytes: 8 + 8 + 32 + 32 + 32 + 1 + (4 + (50 * (32 + 8 + 8 + 10)))
    pub token_amount: u64,     // 8
    pub authority: Pubkey,   // 32
    pub escrow_wallet: Pubkey, // 32
    pub token_mint: Pubkey,    // 32
    pub beneficiaries: Vec<Beneficiary>, // (4 + (n * (32 + 8 + 8 + 8 + 1 +1)))
    pub decimals: u8           // 1
}

#[derive(Accounts)]
#[instruction(data_bump: u8, escrow_bump: u8)]
pub struct WithdrawUnclaimed<'info> {
    #[account(
        mut,
        seeds = [b"data_account", token_mint.key().as_ref()],
        bump = data_bump
    )]
    pub data_account: Account<'info, DataAccount>,

    #[account(
        mut,
        seeds = [b"escrow_wallet", token_mint.key().as_ref()],
        bump = escrow_bump,
    )]
    pub escrow_wallet: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = admin_wallet.owner == admin.key(), 
        constraint = admin_wallet.mint == token_mint.key(),
    )]
    pub admin_wallet: Account<'info, TokenAccount>,

    pub admin: Signer<'info>,
    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

// Events emitted
#[event]
pub struct VestingInitialized {
    pub admin: Pubkey,
    pub token_mint: Pubkey,
    pub total_amount: u64,
    pub beneficiaries_count: u32,
}


#[event]
pub struct TokensClaimed {
    pub beneficiary: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct AllUnclaimedWithdrawn {
    pub admin: Pubkey,
    pub total_amount: u64,
    pub beneficiaries_processed: u32,
    pub timestamp: i64,
}

/// Error codes for the vesting program, describing all possible failure cases.
#[error_code]
pub enum VestingError {
    #[msg("Sender is not owner of Data Account")]
    InvalidSender,
    #[msg("Not allowed to claim new token currently")]
    ClaimNotAllowed,
    #[msg("Beneficiary does not exist in account")]
    BeneficiaryNotFound,
    #[msg("Cliff period has not been reached yet")]
    CliffNotReached,
    #[msg("Too many beneficiaries in vesting schedule")]
    TooManyBeneficiaries,
    #[msg("Invalid vesting configuration: total_months not divisible by cliff_months")]
    InvalidVestingConfig,
    #[msg("Invalid vesting period: total_months must be at least 1")]
    InvalidVestingPeriod,
    #[msg("Cliff period is too long (max 48 months)")]
    CliffTooLong,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("No beneficiaries provided")]
    NoBeneficiaries,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid cliff period")]
    InvalidCliffPeriod,
    #[msg("Invalid allocation")]
    InvalidAllocation,
    #[msg("Invalid start time")]
    InvalidStartTime,
    #[msg("Insufficient balance to claim")]
    InsufficientBalance,
    #[msg("Invalid decimals")]
    InvalidDecimals,
    #[msg("Over allocation of tokens")]
    OverAllocation,
    #[msg("Duplicate beneficiary found")]
    DuplicateBeneficiary,
    #[msg("Unauthorized: only admin can perform this action")]
    UnauthorizedAdmin,
    #[msg("No unclaimed tokens available")]
    NoUnclaimedTokens,
    #[msg("Start time is too far in the future")]
    StartTimeTooFar,
    #[msg("Invalid escrow wallet PDA")]
    InvalidEscrowWallet,
    #[msg("Invalid escrow bump seed")]
    InvalidEscrowBump,
    #[msg("Precision loss occurred")]
    PrecisionLoss,
}
