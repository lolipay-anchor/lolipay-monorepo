#![no_std]

mod events;
mod storage;
pub mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, panic_with_error, token, Address, BytesN, Env, Symbol, Vec};

use crate::events::{
    EarlyReleased,
    ConfigChanged, Disputed, FiatPaid, PausedSet, Released, Refunded, Resolved, TradeCreated,
};
use crate::storage::{
    bump_instance, get_config, has_trade, set_config, set_trade, split_fees,
};
use crate::storage::get_trade as storage_get_trade;
use crate::types::{Config, Error, Flow, ResolveOutcome, Status, Trade};

const RESOLVER_WINDOW: u64 = 86_400;

const MIN_PAY_WINDOW: u64 = 600;
const MAX_PAY_WINDOW: u64 = 86_400;
const MAX_TOTAL_WINDOW: u64 = 2_592_000;

const MAX_LP_FEE_BPS: u32 = 500;

pub const ATTEST_GRACE_SECS: u64 = 3600;
pub const MAX_EARLY_RELEASE_PROVIDERS: u32 = 20;
const MAX_PLATFORM_FEE_BPS: u32 = 500;

const MAX_DISPUTE_WINDOW: u64 = 604_800;

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    pub fn __constructor(
        env: Env,
        admin: Address,
        usdc_token: Address,
        resolver: Address,
        default_platform_fee_bps: u32,
        default_platform_wallet: Address,
        dispute_window: u64,
        fiat_attestor: Address,
    ) {
        admin.require_auth();
        if default_platform_fee_bps > MAX_PLATFORM_FEE_BPS {
            panic_with_error!(&env, Error::InvalidFee);
        }
        if dispute_window == 0 || dispute_window > MAX_DISPUTE_WINDOW {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        if admin == resolver || admin == fiat_attestor || resolver == fiat_attestor {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        set_config(
            &env,
            &Config {
                admin,
                usdc_token,
                resolver,
                default_platform_fee_bps,
                default_platform_wallet,
                paused: false,
                dispute_window,
                fiat_attestor,
                early_release_providers: Vec::new(&env),
            },
        );
    }

    pub fn get_config(env: Env) -> Result<Config, Error> {
        get_config(&env).ok_or(Error::NotInitialized)
    }

    pub fn set_config(env: Env, new_config: Config) -> Result<(), Error> {
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        cfg.admin.require_auth();
        if new_config.usdc_token != cfg.usdc_token {
            return Err(Error::TokenImmutable);
        }
        if new_config.default_platform_wallet != cfg.default_platform_wallet {
            return Err(Error::WalletImmutable);
        }
        if new_config.fiat_attestor != cfg.fiat_attestor {
            return Err(Error::InvalidConfig);
        }
        if new_config.early_release_providers.len() > MAX_EARLY_RELEASE_PROVIDERS {
            return Err(Error::InvalidConfig);
        }
        if new_config.admin == new_config.resolver
            || new_config.admin == new_config.fiat_attestor
            || new_config.resolver == new_config.fiat_attestor
        {
            return Err(Error::InvalidConfig);
        }
        if new_config.default_platform_fee_bps > MAX_PLATFORM_FEE_BPS {
            return Err(Error::InvalidFee);
        }
        if new_config.dispute_window == 0 || new_config.dispute_window > MAX_DISPUTE_WINDOW {
            return Err(Error::InvalidConfig);
        }
        new_config.admin.require_auth();
        let (admin, resolver) = (new_config.admin.clone(), new_config.resolver.clone());
        set_config(&env, &new_config);
        ConfigChanged { admin, resolver }.publish(&env);
        Ok(())
    }

    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        let mut cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        cfg.admin.require_auth();
        cfg.paused = paused;
        set_config(&env, &cfg);
        PausedSet { paused }.publish(&env);
        Ok(())
    }

    pub fn get_trade(env: Env, trade_id: BytesN<32>) -> Result<Trade, Error> {
        storage_get_trade(&env, &trade_id).ok_or(Error::TradeNotFound)
    }

    pub fn dispute_view(
        env: Env,
        trade_id: BytesN<32>,
    ) -> Result<(bool, Address, Address, i128, bool), Error> {
        let t = storage_get_trade(&env, &trade_id).ok_or(Error::TradeNotFound)?;
        let pre_settlement = t.settled_at == 0;
        Ok((
            t.status == Status::Disputed,
            t.usdc_provider,
            t.usdc_recipient,
            t.usdc_amount,
            pre_settlement,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_trade(
        env: Env,
        trade_id: BytesN<32>,
        usdc_provider: Address,
        usdc_recipient: Address,
        confirmer: Address,
        usdc_amount: i128,
        fiat_amount: i128,
        fiat_currency: Symbol,
        flow: Flow,
        platform_fee_bps: u32,
        lp_fee_bps: u32,
        platform_wallet: Address,
        lp_wallet: Address,
        pay_deadline: u64,
        confirm_deadline: u64,
        dispute_deadline: u64,
    ) -> Result<(), Error> {
        bump_instance(&env);
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        if cfg.paused {
            return Err(Error::Paused);
        }
        if has_trade(&env, &trade_id) {
            return Err(Error::TradeExists);
        }
        if usdc_amount <= 0 || fiat_amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if confirmer != usdc_provider || usdc_provider == usdc_recipient {
            return Err(Error::InvalidRoles);
        }
        if (platform_fee_bps as i128) + (lp_fee_bps as i128) >= 10_000 {
            return Err(Error::InvalidFee);
        }
        if platform_fee_bps != cfg.default_platform_fee_bps
            || platform_wallet != cfg.default_platform_wallet
        {
            return Err(Error::InvalidFee);
        }
        if lp_fee_bps > MAX_LP_FEE_BPS {
            return Err(Error::InvalidFee);
        }
        let now = env.ledger().timestamp();
        if !(now < pay_deadline
            && pay_deadline < confirm_deadline
            && confirm_deadline < dispute_deadline)
        {
            return Err(Error::InvalidDeadlines);
        }
        if pay_deadline < now + MIN_PAY_WINDOW {
            return Err(Error::InvalidDeadlines);
        }
        if pay_deadline > now + MAX_PAY_WINDOW || dispute_deadline > now + MAX_TOTAL_WINDOW {
            return Err(Error::InvalidDeadlines);
        }

        usdc_provider.require_auth();

        let trade = Trade {
            status: Status::Funded,
            usdc_provider: usdc_provider.clone(),
            usdc_recipient,
            confirmer,
            usdc_token: cfg.usdc_token.clone(),
            usdc_amount,
            fiat_amount,
            fiat_currency,
            flow,
            platform_fee_bps,
            lp_fee_bps,
            platform_wallet,
            lp_wallet,
            created_at: now,
            pay_deadline,
            confirm_deadline,
            dispute_deadline,
            disputed_by: None,
            resolver_deadline: 0,
            settled_at: 0,
            has_pre_dispute_status: false,
            pre_dispute_status: Status::Funded,
            post_settle_resolved: false,
            resolver_post_settle_used: false,
            post_settle_deadline: 0,
        };
        set_trade(&env, &trade_id, &trade);

        token::TokenClient::new(&env, &trade.usdc_token).transfer(
            &usdc_provider,
            env.current_contract_address(),
            &usdc_amount,
        );

        TradeCreated {
            trade_id,
            usdc_amount,
        }
        .publish(&env);
        Ok(())
    }

    pub fn mark_fiat_paid(env: Env, trade_id: BytesN<32>, caller: Address) -> Result<(), Error> {
        bump_instance(&env);
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        let mut trade = storage_get_trade(&env, &trade_id).ok_or(Error::TradeNotFound)?;
        if trade.status != Status::Funded {
            return Err(Error::InvalidState);
        }
        let deadline = if caller == cfg.fiat_attestor && trade.flow == Flow::TopUp {
            if cfg.paused {
                return Err(Error::Paused);
            }
            core::cmp::min(trade.confirm_deadline, trade.pay_deadline + ATTEST_GRACE_SECS)
        } else if caller == trade.usdc_recipient {
            trade.pay_deadline
        } else {
            return Err(Error::Unauthorized);
        };
        if env.ledger().timestamp() > deadline {
            return Err(Error::DeadlinePassed);
        }
        caller.require_auth();
        trade.status = Status::FiatPaid;
        set_trade(&env, &trade_id, &trade);
        FiatPaid { trade_id }.publish(&env);
        Ok(())
    }

    pub fn release_from_funded(env: Env, trade_id: BytesN<32>) -> Result<(), Error> {
        bump_instance(&env);
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        let mut trade = storage_get_trade(&env, &trade_id).ok_or(Error::TradeNotFound)?;
        if trade.status != Status::Funded {
            return Err(Error::InvalidState);
        }
        if cfg.paused {
            return Err(Error::Paused);
        }
        if trade.flow != Flow::TopUp {
            return Err(Error::EarlyReleaseNotAllowed);
        }
        if !cfg.early_release_providers.contains(&trade.usdc_provider) {
            return Err(Error::EarlyReleaseNotAllowed);
        }
        let deadline =
            core::cmp::min(trade.confirm_deadline, trade.pay_deadline + ATTEST_GRACE_SECS);
        if env.ledger().timestamp() > deadline {
            return Err(Error::DeadlinePassed);
        }
        cfg.fiat_attestor.require_auth();
        trade.confirmer.require_auth();

        let (platform_fee, lp_fee, net) =
            split_fees(trade.usdc_amount, trade.platform_fee_bps, trade.lp_fee_bps);

        trade.status = Status::Released;
        trade.settled_at = env.ledger().timestamp();
        trade.post_settle_deadline = trade.settled_at + cfg.dispute_window;
        set_trade(&env, &trade_id, &trade);

        let token = token::TokenClient::new(&env, &trade.usdc_token);
        let contract = env.current_contract_address();
        if platform_fee > 0 {
            token.transfer(&contract, &trade.platform_wallet, &platform_fee);
        }
        if lp_fee > 0 {
            token.transfer(&contract, &trade.lp_wallet, &lp_fee);
        }
        token.transfer(&contract, &trade.usdc_recipient, &net);

        EarlyReleased { trade_id, net, platform_fee, lp_fee }.publish(&env);
        Ok(())
    }

    pub fn confirm_and_release(env: Env, trade_id: BytesN<32>) -> Result<(), Error> {
        bump_instance(&env);
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        let mut trade = storage_get_trade(&env, &trade_id).ok_or(Error::TradeNotFound)?;
        if trade.status != Status::FiatPaid {
            return Err(Error::InvalidState);
        }
        trade.confirmer.require_auth();

        let (platform_fee, lp_fee, net) =
            split_fees(trade.usdc_amount, trade.platform_fee_bps, trade.lp_fee_bps);

        trade.status = Status::Released;
        trade.settled_at = env.ledger().timestamp();
        trade.post_settle_deadline = trade.settled_at + cfg.dispute_window;
        set_trade(&env, &trade_id, &trade);

        let token = token::TokenClient::new(&env, &trade.usdc_token);
        let contract = env.current_contract_address();
        if platform_fee > 0 {
            token.transfer(&contract, &trade.platform_wallet, &platform_fee);
        }
        if lp_fee > 0 {
            token.transfer(&contract, &trade.lp_wallet, &lp_fee);
        }
        token.transfer(&contract, &trade.usdc_recipient, &net);

        Released { trade_id, net, platform_fee, lp_fee }.publish(&env);
        Ok(())
    }

    pub fn refund(env: Env, trade_id: BytesN<32>) -> Result<(), Error> {
        bump_instance(&env);
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        let mut trade = storage_get_trade(&env, &trade_id).ok_or(Error::TradeNotFound)?;
        if trade.status != Status::Funded {
            return Err(Error::InvalidState);
        }
        let opens_at = if trade.flow == Flow::TopUp {
            core::cmp::min(trade.confirm_deadline, trade.pay_deadline + ATTEST_GRACE_SECS)
        } else {
            trade.pay_deadline
        };
        if env.ledger().timestamp() <= opens_at {
            return Err(Error::DeadlineNotReached);
        }
        let token = trade.usdc_token.clone();
        Self::do_refund(&env, &token, &trade_id, &mut trade, cfg.dispute_window);
        Ok(())
    }

    pub fn cancel(env: Env, trade_id: BytesN<32>) -> Result<(), Error> {
        bump_instance(&env);
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        let mut trade = storage_get_trade(&env, &trade_id).ok_or(Error::TradeNotFound)?;
        if trade.status != Status::Funded {
            return Err(Error::InvalidState);
        }
        trade.usdc_provider.require_auth();
        trade.usdc_recipient.require_auth();
        let token = trade.usdc_token.clone();
        Self::do_refund(&env, &token, &trade_id, &mut trade, cfg.dispute_window);
        Ok(())
    }

    pub fn raise_dispute(env: Env, trade_id: BytesN<32>, by: Address) -> Result<(), Error> {
        bump_instance(&env);
        let mut trade = storage_get_trade(&env, &trade_id).ok_or(Error::TradeNotFound)?;
        let now = env.ledger().timestamp();
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        let prior_status: Option<Status> = match trade.status {
            Status::FiatPaid => None,
            Status::Funded => {
                if cfg.paused {
                    return Err(Error::Paused);
                }
                if trade.flow != Flow::TopUp {
                    return Err(Error::DisputeNotAllowed);
                }
                if now > trade.dispute_deadline {
                    return Err(Error::DeadlinePassed);
                }
                Some(Status::Funded)
            }
            Status::Released | Status::Refunded => {
                if trade.settled_at == 0 {
                    return Err(Error::InvalidState);
                }
                if by == cfg.resolver {
                    if trade.resolver_post_settle_used {
                        return Err(Error::AlreadyResolved);
                    }
                } else if trade.post_settle_resolved {
                    return Err(Error::AlreadyResolved);
                }
                if now > trade.post_settle_deadline {
                    return Err(Error::DisputeWindowPassed);
                }
                Some(trade.status)
            }
            _ => return Err(Error::InvalidState),
        };
        let by_resolver = by == cfg.resolver;
        if trade.status == Status::Funded {
            if !by_resolver {
                return Err(Error::Unauthorized);
            }
        } else if !by_resolver && by != trade.usdc_provider && by != trade.usdc_recipient {
            return Err(Error::Unauthorized);
        }
        by.require_auth();
        if let Some(prior) = prior_status {
            trade.set_pre_dispute_status(Some(prior));
        }
        trade.status = Status::Disputed;
        trade.disputed_by = Some(by.clone());
        trade.resolver_deadline = now + RESOLVER_WINDOW;
        set_trade(&env, &trade_id, &trade);
        Disputed { trade_id, by }.publish(&env);
        Ok(())
    }

    pub fn resolve(
        env: Env,
        trade_id: BytesN<32>,
        outcome: ResolveOutcome,
        caller: Address,
    ) -> Result<(), Error> {
        bump_instance(&env);
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        let mut trade = storage_get_trade(&env, &trade_id).ok_or(Error::TradeNotFound)?;
        if trade.status != Status::Disputed {
            return Err(Error::NotDisputed);
        }
        let now = env.ledger().timestamp();
        let is_resolver = caller == cfg.resolver;
        let is_admin_fallback = now > trade.resolver_deadline && caller == cfg.admin;
        if !(is_resolver || is_admin_fallback) {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        match trade.pre_dispute_status() {
            Some(Status::Funded) => {
                let admin_unwind = is_admin_fallback && outcome == ResolveOutcome::Refund;
                if !admin_unwind {
                    cfg.fiat_attestor.require_auth();
                }
                trade.set_pre_dispute_status(None);
            }
            Some(prior) => {
                let raised_by_a_party = trade.disputed_by == Some(trade.usdc_provider.clone())
                    || trade.disputed_by == Some(trade.usdc_recipient.clone());
                trade.status = prior;
                trade.set_pre_dispute_status(None);
                trade.post_settle_resolved |= raised_by_a_party;
                trade.resolver_post_settle_used |= !raised_by_a_party;
                set_trade(&env, &trade_id, &trade);
                let released = outcome == ResolveOutcome::Release;
                Resolved { trade_id, released, post_settle: true }.publish(&env);
                return Ok(());
            }
            None => {}
        }

        let token_addr = trade.usdc_token.clone();
        match outcome {
            ResolveOutcome::Refund => {
                Self::do_refund(&env, &token_addr, &trade_id, &mut trade, cfg.dispute_window);
                Resolved { trade_id, released: false, post_settle: false }.publish(&env);
            }
            ResolveOutcome::Release => {
                let (platform_fee, lp_fee, net) =
                    split_fees(trade.usdc_amount, trade.platform_fee_bps, trade.lp_fee_bps);
                trade.status = Status::Released;
                trade.settled_at = now;
                trade.post_settle_deadline = now + cfg.dispute_window;
                set_trade(&env, &trade_id, &trade);
                let token = token::TokenClient::new(&env, &token_addr);
                let contract = env.current_contract_address();
                if platform_fee > 0 {
                    token.transfer(&contract, &trade.platform_wallet, &platform_fee);
                }
                if lp_fee > 0 {
                    token.transfer(&contract, &trade.lp_wallet, &lp_fee);
                }
                token.transfer(&contract, &trade.usdc_recipient, &net);
                Resolved { trade_id, released: true, post_settle: false }.publish(&env);
            }
        }
        Ok(())
    }

    fn do_refund(
        env: &Env,
        usdc_token: &Address,
        trade_id: &BytesN<32>,
        trade: &mut Trade,
        dispute_window: u64,
    ) {
        trade.status = Status::Refunded;
        trade.settled_at = env.ledger().timestamp();
        trade.post_settle_deadline = trade.settled_at + dispute_window;
        set_trade(env, trade_id, trade);
        token::TokenClient::new(env, usdc_token).transfer(
            &env.current_contract_address(),
            &trade.usdc_provider,
            &trade.usdc_amount,
        );
        Refunded { trade_id: trade_id.clone(), amount: trade.usdc_amount }.publish(env);
    }
}
