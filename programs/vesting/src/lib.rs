#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("2Ut9RKeaqo895gVTEZ6fgG9WJ2sZAPfws5Hp3WGkcAg8");

#[program]
pub mod vesting {

    use super::*;

    pub fn initialize(ctx: Context<Initialize>, beneficiaries: Vec<Beneficiary>, amount: u64, decimals: u8) -> Result<()> {
        let data_account = &mut ctx.accounts.data_account;

        data_account.beneficiaries = beneficiaries;
        data_account.token_amount = amount;
        data_account.decimals = decimals;
        data_account.initializer = ctx.accounts.sender.to_account_info().key();
        data_account.escrow_wallet = ctx.accounts.escrow_wallet.to_account_info().key();
        data_account.token_mint = ctx.accounts.token_mint.to_account_info().key();

        let transfer_instruction = Transfer{ 
            from: ctx.accounts.wallet_to_withdraw_from.to_account_info(),
            to: ctx.accounts.escrow_wallet.to_account_info(),
            authority: ctx.accounts.sender.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), transfer_instruction);

        token::transfer(cpi_ctx, data_account.token_amount * u64::pow(10, decimals as u32))?;

        Ok(())
    }


    pub fn claim(ctx: Context<Claim>, data_bump: u8, _escrow_bump: u8) -> Result<()> {
        let sender = &ctx.accounts.sender;
        let escrow_wallet = &ctx.accounts.escrow_wallet;
        let data_account = &mut ctx.accounts.data_account;
        let token_program = &ctx.accounts.token_program;
        let token_mint_key = &ctx.accounts.token_mint.key();
        let beneficiaries_ata = &ctx.accounts.wallet_to_deposit_to;
        let decimals = data_account.decimals;

        let index = data_account
            .beneficiaries
            .iter()
            .position(|b| b.key == *sender.key)
            .ok_or(VestingError::BeneficiaryNotFound)?;

        let beneficiary = data_account.beneficiaries[index];

        let now = Clock::get()?.unix_timestamp;
        let elapsed = now - beneficiary.start_time;
        let cliff_secs = i64::from(beneficiary.cliff_months) * 30 * 24 * 60 * 60;

        // Check if first cliff has passed
        if elapsed < cliff_secs {
            return err!(VestingError::CliffNotReached);
        }

        let total_cliff_periods = beneficiary.total_months / beneficiary.cliff_months;
        let periods_passed = std::cmp::min(
            (elapsed / cliff_secs) as u8,
            total_cliff_periods,
        );

        let total_unlocked = (beneficiary.allocated_tokens as u128 * periods_passed as u128)
            / total_cliff_periods as u128;
        let claimable = total_unlocked.saturating_sub(beneficiary.claimed_tokens as u128) as u64;

        require!(claimable > 0, VestingError::ClaimNotAllowed);

        let seeds = &["data_account".as_bytes(), token_mint_key.as_ref(), &[data_bump]];
        let signer_seeds = &[&seeds[..]];

        let transfer_instruction = Transfer {
            from: escrow_wallet.to_account_info(),
            to: beneficiaries_ata.to_account_info(),
            authority: data_account.to_account_info(),
        };

        let cpi_ctx =
            CpiContext::new_with_signer(token_program.to_account_info(), transfer_instruction, signer_seeds);

        token::transfer(cpi_ctx, claimable * u64::pow(10, decimals as u32))?;

        data_account.beneficiaries[index].claimed_tokens += claimable;
        Ok(())
    }


}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init,
        payer = sender,
        space =  8 + 8 + 32 + 32 + 32 + 1 + (4 + 50 * (32 + 8 + 8 + 8 + 1 + 1) + 1),
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

        #[account(mut,
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

#[derive(Default, Copy, Clone, AnchorSerialize, AnchorDeserialize)]
pub struct Beneficiary {
    pub key: Pubkey,
    pub allocated_tokens: u64,
    pub claimed_tokens: u64,
    pub start_time: i64, 
    pub cliff_months: u8,
    pub total_months: u8,
}


#[account]
#[derive(Default)]
pub struct DataAccount {
    // Space in bytes: 8 + 8 + 32 + 32 + 32 + 1 + (4 + (100 * (32 + 8 + 8 + 10)))
    pub token_amount: u64,     // 8
    pub initializer: Pubkey,   // 32
    pub escrow_wallet: Pubkey, // 32
    pub token_mint: Pubkey,    // 32
    pub beneficiaries: Vec<Beneficiary>, // (4 + (n * (32 + 8 + 8 + 8 + 1 +1)))
    pub decimals: u8           // 1
}


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
}
