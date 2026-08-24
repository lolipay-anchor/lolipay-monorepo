#![no_std]

mod events;
mod storage;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contractimpl, panic_with_error, token, vec, Address, BytesN, Env, IntoVal, Symbol,
};

use crate::events::{
    Reserved, ReservationReleased,ConfigChanged, PausedSet, Slashed, Staked, UnstakeRequested, Unstaked};
use crate::storage::{
    bump_instance, get_config, get_stake, is_slashed, mark_slashed, set_config, set_stake, get_reservation as storage_get_reservation, set_reservation, clear_reservation};
use crate::types::{Config, Error, StakeInfo};

const MAX_COOLDOWN_SECS: u64 = 90 * 24 * 60 * 60;

#[contract]
pub struct StakingContract;

#[contractimpl]
impl StakingContract {
    pub fn __constructor(
        env: Env,
        admin: Address,
        usdc_token: Address,
        resolver: Address,
        escrow_contract: Address,
        min_stake: i128,
        cooldown_secs: u64,
    ) {
        admin.require_auth();
        if cooldown_secs > MAX_COOLDOWN_SECS {
            panic_with_error!(&env, Error::InvalidCooldown);
        }
        if min_stake <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        set_config(
            &env,
            &Config {
                admin,
                usdc_token,
                resolver,
                escrow_contract,
                min_stake,
                cooldown_secs,
                paused: false,
            },
        );
    }

    pub fn get_config(env: Env) -> Result<Config, Error> {
        get_config(&env).ok_or(Error::NotInitialized)
    }

    pub fn set_config(env: Env, new_config: Config) -> Result<(), Error> {
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        cfg.admin.require_auth();
        new_config.admin.require_auth();
        if new_config.usdc_token != cfg.usdc_token {
            return Err(Error::TokenImmutable);
        }
        if new_config.escrow_contract != cfg.escrow_contract {
            return Err(Error::TokenImmutable);
        }
        if new_config.cooldown_secs > MAX_COOLDOWN_SECS {
            return Err(Error::InvalidCooldown);
        }
        if new_config.min_stake <= 0 {
            return Err(Error::InvalidAmount);
        }
        set_config(&env, &new_config);
        ConfigChanged { admin: new_config.admin, resolver: new_config.resolver }.publish(&env);
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

    pub fn get_stake(env: Env, lp: Address) -> StakeInfo {
        get_stake(&env, &lp)
    }

    pub fn stake(env: Env, lp: Address, amount: i128) -> Result<(), Error> {
        bump_instance(&env);
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        if cfg.paused {
            return Err(Error::Paused);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        lp.require_auth();

        let mut info = get_stake(&env, &lp);
        info.staked += amount;
        set_stake(&env, &lp, &info);

        token::TokenClient::new(&env, &cfg.usdc_token).transfer(
            &lp,
            env.current_contract_address(),
            &amount,
        );

        Staked { lp, amount, total_staked: info.staked }.publish(&env);
        Ok(())
    }

    pub fn available(env: Env, lp: Address) -> i128 {
        let info = get_stake(&env, &lp);
        let free = info.staked - info.reserved;
        if free < 0 {
            0
        } else {
            free
        }
    }

    pub fn get_reservation(env: Env, lp: Address, trade_id: BytesN<32>) -> Option<i128> {
        storage_get_reservation(&env, &lp, &trade_id)
    }

    pub fn force_release_reservation(
        env: Env,
        lp: Address,
        trade_id: BytesN<32>,
        caller: Address,
    ) -> Result<(), Error> {
        bump_instance(&env);
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        if caller != cfg.admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        Self::drop_reservation(&env, &lp, &trade_id)
    }

    fn drop_reservation(env: &Env, lp: &Address, trade_id: &BytesN<32>) -> Result<(), Error> {
        let amount = storage_get_reservation(env, lp, trade_id).ok_or(Error::ReservationNotFound)?;
        let mut info = get_stake(env, lp);
        info.reserved -= amount;
        if info.reserved < 0 {
            info.reserved = 0;
        }
        set_stake(env, lp, &info);
        clear_reservation(env, lp, trade_id);
        ReservationReleased {
            lp: lp.clone(),
            trade_id: trade_id.clone(),
            amount,
            total_reserved: info.reserved,
        }
        .publish(env);
        Ok(())
    }

    pub fn is_eligible(env: Env, lp: Address) -> Result<bool, Error> {
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        let info = get_stake(&env, &lp);
        Ok(info.staked - info.reserved >= cfg.min_stake)
    }

    pub fn reserve(
        env: Env,
        lp: Address,
        trade_id: BytesN<32>,
        amount: i128,
        caller: Address,
    ) -> Result<(), Error> {
        bump_instance(&env);
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        if caller != cfg.resolver && caller != cfg.admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        if cfg.paused {
            return Err(Error::Paused);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if is_slashed(&env, &trade_id) {
            return Err(Error::AlreadySlashed);
        }
        let existing = storage_get_reservation(&env, &lp, &trade_id).unwrap_or(0);
        if existing == amount {
            return Ok(());
        }
        if existing > amount {
            return Err(Error::InvalidAmount);
        }
        let delta = amount - existing;
        let mut info = get_stake(&env, &lp);
        if delta > info.staked - info.reserved {
            return Err(Error::InsufficientAvailable);
        }
        info.reserved += delta;
        set_stake(&env, &lp, &info);
        set_reservation(&env, &lp, &trade_id, amount);
        Reserved { lp, trade_id, amount, total_reserved: info.reserved }.publish(&env);
        Ok(())
    }

    pub fn release_reservation(
        env: Env,
        lp: Address,
        trade_id: BytesN<32>,
        caller: Address,
    ) -> Result<(), Error> {
        bump_instance(&env);
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        if caller != cfg.resolver && caller != cfg.admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        if cfg.paused {
            return Err(Error::Paused);
        }
        Self::drop_reservation(&env, &lp, &trade_id)
    }

    pub fn request_unstake(env: Env, lp: Address, amount: i128) -> Result<(), Error> {
        bump_instance(&env);
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        lp.require_auth();
        let mut info = get_stake(&env, &lp);
        if amount > info.staked {
            return Err(Error::InsufficientStaked);
        }
        if amount > info.staked - info.reserved {
            return Err(Error::InsufficientAvailable);
        }
        info.staked -= amount;
        info.unbonding += amount;
        let available_at = env.ledger().timestamp() + cfg.cooldown_secs;
        info.unbond_available_at = available_at;
        set_stake(&env, &lp, &info);
        UnstakeRequested { lp, amount, available_at }.publish(&env);
        Ok(())
    }

    pub fn claim_unstake(env: Env, lp: Address) -> Result<(), Error> {
        bump_instance(&env);
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        lp.require_auth();
        let mut info = get_stake(&env, &lp);
        if info.unbonding <= 0 {
            return Err(Error::NothingToClaim);
        }
        if env.ledger().timestamp() < info.unbond_available_at {
            return Err(Error::CooldownActive);
        }
        let amount = info.unbonding;
        info.unbonding = 0;
        set_stake(&env, &lp, &info);

        let contract = env.current_contract_address();
        token::TokenClient::new(&env, &cfg.usdc_token).transfer(
            &contract,
            &lp,
            &amount,
        );
        Unstaked { lp, amount }.publish(&env);
        Ok(())
    }

    pub fn slash(
        env: Env,
        lp: Address,
        trade_id: BytesN<32>,
        amount: i128,
        caller: Address,
    ) -> Result<(), Error> {
        bump_instance(&env);
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        if caller != cfg.resolver && caller != cfg.admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if is_slashed(&env, &trade_id) {
            return Err(Error::AlreadySlashed);
        }
        let (is_disputed, provider, recipient, trade_amount, funded_origin): (
            bool,
            Address,
            Address,
            i128,
            bool,
        ) = env
            .invoke_contract(
                &cfg.escrow_contract,
                &Symbol::new(&env, "dispute_view"),
                vec![&env, trade_id.into_val(&env)],
            );
        if !is_disputed {
            return Err(Error::TradeNotDisputed);
        }
        if funded_origin {
            return Err(Error::SlashNotApplicable);
        }
        let victim = if lp == provider {
            recipient
        } else if lp == recipient {
            provider
        } else {
            return Err(Error::NotTradeParty);
        };
        if amount > trade_amount {
            return Err(Error::InvalidAmount);
        }

        let mut info = get_stake(&env, &lp);
        if amount > info.staked + info.unbonding {
            return Err(Error::InsufficientStake);
        }
        if amount <= info.staked {
            info.staked -= amount;
        } else {
            let from_unbonding = amount - info.staked;
            info.staked = 0;
            info.unbonding -= from_unbonding;
        }
        if let Some(reserved) = storage_get_reservation(&env, &lp, &trade_id) {
            info.reserved -= reserved;
            clear_reservation(&env, &lp, &trade_id);
        }
        if info.reserved < 0 {
            info.reserved = 0;
        }
        set_stake(&env, &lp, &info);
        mark_slashed(&env, &trade_id);

        let contract = env.current_contract_address();
        token::TokenClient::new(&env, &cfg.usdc_token).transfer(&contract, &victim, &amount);
        Slashed { lp, victim, amount }.publish(&env);
        Ok(())
    }
}
