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
    ConfigChanged, PausedSet, Slashed, Staked, UnstakeRequested, Unstaked};
use crate::storage::{
    add_slashed, bump_instance, get_config, get_stake, set_config, set_stake, slashed_so_far};
use crate::types::{Config, DisputeView, Error, StakeInfo};

const MAX_COOLDOWN_SECS: u64 = 90 * 24 * 60 * 60;
const MIN_COOLDOWN_SECS: u64 = 4 * 24 * 60 * 60 + 1;
pub(crate) const ESCROW_TRADE_NOT_FOUND: u32 = 5;

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
        if !(MIN_COOLDOWN_SECS..=MAX_COOLDOWN_SECS).contains(&cooldown_secs) {
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
        if !(MIN_COOLDOWN_SECS..=MAX_COOLDOWN_SECS).contains(&new_config.cooldown_secs) {
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
        get_stake(&env, &lp).staked
    }

    fn read_dispute(
        env: &Env,
        escrow: &Address,
        trade_id: &BytesN<32>,
    ) -> Result<Option<DisputeView>, Error> {
        let found: Result<
            Result<DisputeView, soroban_sdk::ConversionError>,
            Result<soroban_sdk::Error, soroban_sdk::InvokeError>,
        > = env.try_invoke_contract(
            escrow,
            &Symbol::new(env, "dispute_view"),
            vec![env, trade_id.into_val(env)],
        );
        match found {
            Ok(Ok(view)) => Ok(Some(view)),
            Err(Ok(e))
                if e.is_type(soroban_sdk::xdr::ScErrorType::Contract)
                    && e.get_code() == ESCROW_TRADE_NOT_FOUND =>
            {
                Ok(None)
            }
            _ => Err(Error::EscrowUnreadable),
        }
    }

    pub fn slashed(env: Env, trade_id: BytesN<32>) -> i128 {
        slashed_so_far(&env, &trade_id)
    }

    pub fn is_eligible(env: Env, lp: Address) -> Result<bool, Error> {
        let cfg = get_config(&env).ok_or(Error::NotInitialized)?;
        let info = get_stake(&env, &lp);
        Ok(info.staked >= cfg.min_stake)
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
        info.staked -= amount;
        info.unbonding += amount;
        info.unbond_available_at = core::cmp::max(
            info.unbond_available_at,
            env.ledger().timestamp() + cfg.cooldown_secs,
        );
        let available_at = info.unbond_available_at;
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
        let view = Self::read_dispute(&env, &cfg.escrow_contract, &trade_id)?
            .ok_or(Error::TradeNotDisputed)?;
        if view.pre_settlement {
            return Err(Error::SlashNotApplicable);
        }
        if !view.post_settle_raised {
            return Err(Error::TradeNotDisputed);
        }
        if !view.liability_established {
            return Err(if view.is_disputed {
                Error::VerdictPending
            } else {
                Error::NoLiabilityFound
            });
        }
        if env.ledger().timestamp() > view.slash_deadline {
            return Err(Error::SlashWindowPassed);
        }
        let trade_amount = view.amount;
        if lp != view.provider && lp != view.recipient {
            return Err(Error::NotTradeParty);
        }
        let (culprit, victim) = if view.released {
            (view.recipient.clone(), view.provider.clone())
        } else {
            (view.provider.clone(), view.recipient.clone())
        };
        if lp != culprit {
            return Err(Error::SlashNotApplicable);
        }
        let already = slashed_so_far(&env, &trade_id);
        if already >= trade_amount {
            return Err(Error::AlreadySlashed);
        }
        if amount > trade_amount - already {
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
        if info.unbonding == 0 {
            info.unbond_available_at = 0;
        }
        set_stake(&env, &lp, &info);
        add_slashed(&env, &trade_id, amount);

        let contract = env.current_contract_address();
        token::TokenClient::new(&env, &cfg.usdc_token).transfer(&contract, &victim, &amount);
        Slashed { lp, victim, amount }.publish(&env);
        Ok(())
    }
}
