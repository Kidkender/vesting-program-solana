// ================================================================================================
// SOLANA TOKEN VESTING PROGRAM
// ================================================================================================
// A secure, multi-beneficiary token vesting program with cliff periods and grace period recovery.
//
// Features:
// - Multi-beneficiary vesting with individual cliff periods
// - Admin recovery of unclaimed tokens after grace period
// - Precision-safe calculations using 128-bit arithmetic
// - Comprehensive input validation and overflow protection
//
// Security Considerations:
// - Uses Program Derived Addresses (PDAs) for escrow security
// - Implements checks-effects-interactions pattern
// - Validates all time-based calculations with safety caps
// ================================================================================================

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

// ================================================================================================
// CONSTANTS
// ================================================================================================

/// Average seconds in a month (30.44 days) for vesting calculations
pub const SECONDS_PER_MONTH: i64 = 2_629_776;
/// Grace period after vesting completion before admin can withdraw unclaimed tokens
pub const GRACE_PERIOD: i64 = 6 * SECONDS_PER_MONTH;
/// Maximum allowed delay for vesting start time (prevents far-future exploits)
pub const MAX_START_DELAY: i64 = 365 * 24 * 60 * 60; 
/// Maximum number of beneficiaries per vesting schedule (prevents DoS)
pub const MAX_BENEFICIARIES: usize = 50;
/// Maximum token decimals supported
pub const MAX_DECIMALS: u8 = 9;

declare_id!("94XXemxbSsTsKxdEzsfQX76BmV2Uo2JSbVeSC61a6zDp");

// ================================================================================================
// PROGRAM INSTRUCTIONS
// ================================================================================================
#[program]
pub mod vesting {

    use super::*;

    /// Initializes a new vesting schedule for multiple beneficiaries.
    /// 
    /// This function sets up a token vesting contract with multiple beneficiaries,
    /// each having their own cliff period and vesting duration. The admin transfers
    /// tokens to an escrow account controlled by the program.
    /// 
    /// # Arguments
    /// * `beneficiaries` - Vector of beneficiary configurations (max 50)
    /// * `amount` - Total tokens to vest in RAW UNITS (e.g., 1000 tokens with 9 decimals = 1_000_000_000_000)
    /// * `decimals` - Token decimals for reference (all calculations use raw units)
    pub fn initialize(
        ctx: Context<Initialize>, 
        beneficiaries: Vec<Beneficiary>, 
        amount: u64, // RAW UNITS: Total tokens in smallest denomination
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
        require!(beneficiaries.len() <= MAX_BENEFICIARIES, VestingError::TooManyBeneficiaries);
        require!(amount > 0, VestingError::InvalidAmount);
        require!(decimals <= MAX_DECIMALS, VestingError::InvalidDecimals);

        let mut seen = std::collections::HashSet::new();

        for b in beneficiaries.iter() {
            // Validate vesting periods
            require!(b.total_months >= 1, VestingError::InvalidVestingPeriod);
            require!(b.cliff_months <= 48, VestingError::CliffTooLong);
            require!(b.cliff_months < b.total_months, VestingError::InvalidCliffPeriod);
            
            require!(b.allocated_tokens > 0, VestingError::InvalidAllocation);
            
            // Validate time bounds
            require!(b.start_time >= now, VestingError::InvalidStartTime);
            require!(
                b.start_time <= now + MAX_START_DELAY,
                VestingError::StartTimeTooFar
            );

             // Validate vesting configuration consistency
            if b.cliff_months > 0 {
                require!(b.total_months % b.cliff_months == 0, VestingError::InvalidVestingConfig);
            }
            
            // Prevent duplicate beneficiaries
            require!(seen.insert(b.key), VestingError::DuplicateBeneficiary);            
        }

        // Validate total allocation against available amount (all in raw units)
        let mut total_allocated = 0u64;
        for b in beneficiaries.iter() {
            total_allocated = total_allocated
                .checked_add(b.allocated_tokens)
                .ok_or(VestingError::MathOverflow)?;
        }
        require!(total_allocated <= amount, VestingError::OverAllocation);

        // Store vesting configuration
        data_account.beneficiaries = beneficiaries;
        data_account.token_amount = amount;
        data_account.decimals = decimals;
        data_account.escrow_wallet = ctx.accounts.escrow_wallet.to_account_info().key();
        data_account.token_mint = ctx.accounts.token_mint.to_account_info().key();

        // Transfer tokens to escrow 
        let transfer_instruction = Transfer{ 
            from: ctx.accounts.wallet_to_withdraw_from.to_account_info(),
            to: ctx.accounts.escrow_wallet.to_account_info(),
            authority: ctx.accounts.sender.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), transfer_instruction);   

        require!(ctx.accounts.wallet_to_withdraw_from.amount >= amount, VestingError::InsufficientBalance);

        token::transfer(cpi_ctx, amount)?;

        // Emit initialization event
        emit!(VestingInitialized {
            admin: ctx.accounts.sender.key(),
            token_mint: ctx.accounts.token_mint.key(),
            total_amount: amount,
            beneficiaries_count: data_account.beneficiaries.len() as u32,
        });

        Ok(())
    }

    /// Claims unlocked tokens for a beneficiary according to their vesting schedule.
    /// 
    /// Note: Vesting is calculated in discrete monthly steps, not continuously per second.
    /// 
    /// This function calculates the amount of tokens that have vested for the calling
    /// beneficiary and transfers the claimable amount to their wallet. The calculation
    /// considers cliff periods and linear vesting over the specified duration.
    /// 
    /// # Arguments
    /// * `data_bump` - Bump seed for data account PDA validation
    /// * `escrow_bump` - Bump seed for escrow wallet PDA validation
    /// 
    /// # Vesting Logic
    /// 1. Check if cliff period has passed
    /// 2. Calculate months elapsed since start time
    /// 3. Compute linear vesting: (months_vested / total_vesting_months) * allocated_tokens
    /// 4. Subtract already claimed tokens to get claimable amount
    pub fn claim(ctx: Context<Claim>, data_bump: u8, escrow_bump: u8) -> Result<()> {
        let sender = &ctx.accounts.sender;
        let escrow_wallet = &ctx.accounts.escrow_wallet;
        let data_account = &mut ctx.accounts.data_account;
        let token_mint_key = &ctx.accounts.token_mint.key();

        let token_program = &ctx.accounts.token_program;
        let beneficiaries_ata = &ctx.accounts.wallet_to_deposit_to;

        // Validate escrow wallet PDA
        let (expected_escrow_pda, expected_escrow_bump) = Pubkey::find_program_address(
            &[b"escrow_wallet".as_ref(), token_mint_key.as_ref()],
            ctx.program_id
        );
        require!(ctx.accounts.escrow_wallet.key() == expected_escrow_pda,
            VestingError::InvalidEscrowWallet
        );
        require!(escrow_bump == expected_escrow_bump,
            VestingError::InvalidEscrowBump);

        // Find beneficiary in the list
        let index = data_account
            .beneficiaries
            .iter()
            .position(|b| b.key == *sender.key)
            .ok_or(VestingError::BeneficiaryNotFound)?;

        let beneficiary = data_account.beneficiaries[index];
        let now = Clock::get()?.unix_timestamp;

        // Calculate vesting periods
        let cliff_months = beneficiary.cliff_months as u64;
        let total_months = beneficiary.total_months as u64;                                     
        let vesting_month = total_months - cliff_months;

        require!(vesting_month > 0, VestingError::InvalidVestingConfig);
 
         // Calculate elapsed time with safety cap
        let months_elapsed = if now >= beneficiary.start_time {
            let time_diff = now.saturating_sub(beneficiary.start_time);
            let calculated_months = time_diff.checked_div(SECONDS_PER_MONTH).ok_or(VestingError::MathOverflow)?;
            calculated_months as u64
        } else {
            0u64
        };

        // Check if cliff period has passed
        if months_elapsed < cliff_months {
            return err!(VestingError::CliffNotReached);
        }

        let months_vested = std::cmp::min(months_elapsed - cliff_months, vesting_month);

        // Calculate unlocked tokens using 128-bit arithmetic for precision
        let allocated_raw = beneficiary.allocated_tokens as u128; // RAW UNITS
        let claimed_raw = beneficiary.claimed_tokens as u128;     // RAW UNITS
                
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
        
        data_account.beneficiaries[index].claimed_tokens = data_account.beneficiaries[index].claimed_tokens
            .checked_add(transfer_amount)
            .ok_or(VestingError::MathOverflow)?;
        
        token::transfer(cpi_ctx, transfer_amount)?;

        emit!(TokensClaimed {
            beneficiary: sender.key(),
            amount: transfer_amount,
            timestamp: now,
        });

        Ok(())
    }

    /// Withdraws unclaimed tokens back to admin after vesting period plus grace period.
    /// 
    /// This function allows the admin to recover tokens that remain unclaimed after
    /// the vesting period has completed plus a grace period. This prevents tokens
    /// from being permanently locked in the contract.
    /// # Arguments
    /// * `data_bump` - Bump seed for data account PDA validation
    /// * `escrow_bump` - Bump seed for escrow wallet PDA validation
    /// 
    /// # Withdrawal Logic
    /// 1. Check if grace period has passed for each beneficiary
    /// 2. Calculate unclaimed tokens for expired beneficiaries
    /// 3. Transfer total unclaimed amount to admin wallet
    /// 4. Mark beneficiaries as fully claimed to prevent future claims
    ///    
    /// # Grace Period Calculation
    /// Withdrawal allowed after: MAX(cliff_end + grace_period, vesting_end + grace_period)
    /// This ensures beneficiaries have sufficient time to claim after both cliff and full vesting
    pub fn withdraw(
        ctx: Context<WithdrawUnclaimed>,
        data_bump: u8,
        escrow_bump: u8,
    ) -> Result<()> {
        let data_account = &mut ctx.accounts.data_account;
        let escrow_wallet = &ctx.accounts.escrow_wallet;
        let admin_wallet = &ctx.accounts.admin_wallet;
        let token_mint_key = &ctx.accounts.token_mint.key();

        // Validate escrow wallet PDA
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

        require!(
            data_account.authority == ctx.accounts.admin.key(), 
            VestingError::UnauthorizedAdmin
        );

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

            // Check if grace period has passed
            if now > earliest_withdraw_time {
                let unclaimed_tokens = beneficiary.allocated_tokens
                    .saturating_sub(beneficiary.claimed_tokens);

                if unclaimed_tokens > 0 {
                    total_unclaimed = total_unclaimed
                        .checked_add(unclaimed_tokens)
                        .ok_or(VestingError::MathOverflow)?;
                    data_account.beneficiaries[i].claimed_tokens = beneficiary.allocated_tokens;
                    _beneficiaries_processed = _beneficiaries_processed
                        .checked_add(1)
                        .ok_or(VestingError::MathOverflow)?;
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

    /// Changes the admin of the vesting program.
    /// 
    /// This function allows the current admin to transfer ownership of the vesting program
    /// to a new admin. The new admin must be a valid Solana address and must not be the same
    /// as the current admin.
    pub fn change_admin(
        ctx: Context<ChangeAdmin>,
        _data_bump: u8,
    )-> Result<()> {
        let  data_account = &mut ctx.accounts.data_account;
        require!(data_account.authority == ctx.accounts.current_admin.key(), VestingError::UnauthorizedAdmin);

        data_account.authority = ctx.accounts.new_admin.key();

        emit!(AdminChanged {
            old_admin: ctx.accounts.current_admin.key(),
            new_admin: ctx.accounts.new_admin.key(),
            timestamp: Clock::get()?.unix_timestamp
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

// ================================================================================================
// ACCOUNT STRUCTURES
// ================================================================================================

/// Account validation for initialize instruction
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

/// Account validation for initialize instruction
/// - data_account: storing vesting configuration (PDA)
/// - escrow_wallet: holding vested tokens (PDA)
/// - sender: Beneficiary claiming tokens
/// - token_mint: Token mint for the vesting program
/// - wallet_to_deposit_to: Beneficiary's token account (created if needed)
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

/// Account validation for withdraw instruction
/// - data_account: storing vesting configuration (PDA)
/// - escrow_wallet: holding vested tokens (PDA)
/// - admin_wallet: Admin's token account to receive unclaimed tokens
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


/// Account validation for change_admin instruction
/// - data_account: Stores vesting state (PDA)
/// - current_admin: Current admin (must sign)
/// - new_admin: New admin address
#[derive(Accounts)]
#[instruction(data_bump: u8)]
pub struct ChangeAdmin<'info> {
    #[account(
        mut,
        seeds = [b"data_account", token_mint.key().as_ref()],
        bump = data_bump,
        constraint = data_account.authority == current_admin.key() @VestingError::UnauthorizedAdmin,
    )]
    pub data_account: Account<'info, DataAccount>,

    #[account(mut)]
    pub current_admin: Signer<'info>,
    
    #[account(
        mut,
        constraint = new_admin.key() != current_admin.key() @VestingError::SameAdmin,
        constraint = new_admin.key() != Pubkey::default()   @VestingError::InvalidAddress
    )]
    pub new_admin: UncheckedAccount<'info>,

    pub token_mint: Account<'info, Mint>
}

// ================================================================================================
// DATA STRUCTURES
// ================================================================================================

/// Configuration for a single beneficiary in the vesting schedule
/// - key: Beneficiary's address.
/// - allocated_tokens: Total tokens allocated.
/// - claimed_tokens: Tokens already claimed.
/// - start_time: Vesting start timestamp.
/// - cliff_months: Number of cliff months.
/// - total_months: Total vesting duration in months.
#[derive(Default, Copy, Clone, AnchorSerialize, AnchorDeserialize)]
pub struct Beneficiary {
    pub key: Pubkey,
    pub allocated_tokens: u64, // RAW UNITS
    pub claimed_tokens: u64,   // RAW UNITS
    pub start_time: i64, 
    pub cliff_months: u8,
    pub total_months: u8,
}

/// Main account storing all vesting program state.
/// - token_amount: Total tokens for vesting - RAW UNITS.
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

// ================================================================================================
// EVENTS
// ================================================================================================

/// Emitted when vesting program is successfully initialized
#[event]
pub struct VestingInitialized {
    pub admin: Pubkey,
    pub token_mint: Pubkey,
    pub total_amount: u64,
    pub beneficiaries_count: u32,
}

/// Emitted when a beneficiary claims vested tokens
#[event]
pub struct TokensClaimed {
    pub beneficiary: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

/// Emitted when admin withdraws unclaimed tokens after grace period
#[event]
pub struct AllUnclaimedWithdrawn {
    pub admin: Pubkey,
    pub total_amount: u64,
    pub beneficiaries_processed: u32,
    pub timestamp: i64,
}

/// Emitted when admin changes
#[event]
pub struct AdminChanged {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
    pub timestamp: i64
}

// ================================================================================================
// ERROR CODES
// ================================================================================================

/// Comprehensive error codes for the vesting program
/// 
/// These errors provide specific feedback for various failure scenarios
/// and help with debugging and user experience.
#[error_code]
pub enum VestingError {
    #[msg("Unauthorized: sender is not the program admin")]
    InvalidSender,
    #[msg("No tokens available to claim at this time")]
    ClaimNotAllowed,
    #[msg("Beneficiary address not found in vesting program")]
    BeneficiaryNotFound,
    #[msg("Cliff period has not elapsed - tokens not yet available")]
    CliffNotReached,
    #[msg("Too many beneficiaries - maximum 50 allowed")]
    TooManyBeneficiaries,
    #[msg("Invalid vesting configuration: total months must be divisible by cliff months")]
    InvalidVestingConfig,
    #[msg("Invalid vesting period: must be at least 1 month")]
    InvalidVestingPeriod,
    #[msg("Cliff period too long - maximum 48 months allowed")]
    CliffTooLong,
    #[msg("Mathematical overflow detected in calculation")]
    MathOverflow,
    #[msg("At least one beneficiary must be specified")]
    NoBeneficiaries,
    #[msg("Token amount must be greater than zero")]
    InvalidAmount,
    #[msg("Cliff period must be less than total vesting period")]
    InvalidCliffPeriod,
    #[msg("Beneficiary allocation must be greater than zero")]
    InvalidAllocation,
    #[msg("Start time must be in the future")]
    InvalidStartTime,
    #[msg("Insufficient token balance for requested operation")]
    InsufficientBalance,
    #[msg("Token decimals must be 9 or less")]
    InvalidDecimals,
    #[msg("Total beneficiary allocations exceed available tokens")]
    OverAllocation,
    #[msg("Duplicate beneficiary address detected")]
    DuplicateBeneficiary,
    #[msg("Unauthorized: only program admin can perform this action")]
    UnauthorizedAdmin,
    #[msg("No unclaimed tokens available for withdrawal")]
    NoUnclaimedTokens,
    #[msg("Start time is too far in future")]
    StartTimeTooFar,
    #[msg("Invalid escrow wallet - PDA verification failed")]
    InvalidEscrowWallet,
    #[msg("Invalid escrow bump seed")]
    InvalidEscrowBump,
    #[msg("Cannot set admin to the same address")]
    SameAdmin,
    #[msg("Invalid admin address")]
    InvalidAddress,
}
