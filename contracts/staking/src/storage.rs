#![allow(dead_code)]
use soroban_sdk::{Address, Env};

use crate::types::{Config, DataKey, StakeInfo};

const DAY_IN_LEDGERS: u32 = 17280;
const BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const LIFETIME: u32 = 45 * DAY_IN_LEDGERS;

pub fn get_config(env: &Env) -> Option<Config> {
    env.storage().instance().get(&DataKey::Config)
}

pub fn set_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, LIFETIME);
}

pub fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, LIFETIME);
}

pub fn get_stake(env: &Env, lp: &Address) -> StakeInfo {
    let key = DataKey::Stake(lp.clone());
    match env.storage().persistent().get::<DataKey, StakeInfo>(&key) {
        Some(info) => {
            env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, LIFETIME);
            info
        }
        None => StakeInfo { staked: 0, reserved: 0, unbonding: 0, unbond_available_at: 0 },
    }
}

pub fn set_stake(env: &Env, lp: &Address, info: &StakeInfo) {
    let key = DataKey::Stake(lp.clone());
    env.storage().persistent().set(&key, info);
    env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, LIFETIME);
}

pub fn is_slashed(env: &Env, trade_id: &soroban_sdk::BytesN<32>) -> bool {
    env.storage().persistent().has(&DataKey::Slashed(trade_id.clone()))
}

pub fn mark_slashed(env: &Env, trade_id: &soroban_sdk::BytesN<32>) {
    let key = DataKey::Slashed(trade_id.clone());
    env.storage().persistent().set(&key, &true);
    env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, LIFETIME);
}

pub fn get_reservation(
    env: &Env,
    lp: &Address,
    trade_id: &soroban_sdk::BytesN<32>,
) -> Option<i128> {
    let key = DataKey::Reservation(lp.clone(), trade_id.clone());
    match env.storage().persistent().get::<DataKey, i128>(&key) {
        Some(amount) => {
            env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, LIFETIME);
            Some(amount)
        }
        None => None,
    }
}

pub fn set_reservation(
    env: &Env,
    lp: &Address,
    trade_id: &soroban_sdk::BytesN<32>,
    amount: i128,
) {
    let key = DataKey::Reservation(lp.clone(), trade_id.clone());
    env.storage().persistent().set(&key, &amount);
    env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, LIFETIME);
}

pub fn clear_reservation(env: &Env, lp: &Address, trade_id: &soroban_sdk::BytesN<32>) {
    env.storage()
        .persistent()
        .remove(&DataKey::Reservation(lp.clone(), trade_id.clone()));
}
