use soroban_sdk::{Address, Env};

use crate::types::{Config, DataKey, StakeInfo};

const DAY_IN_LEDGERS: u32 = 17280;
const INSTANCE_BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME: u32 = 90 * DAY_IN_LEDGERS;
const STAKE_BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const STAKE_LIFETIME: u32 = 90 * DAY_IN_LEDGERS;
const SLASHED_BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const SLASHED_LIFETIME: u32 = 90 * DAY_IN_LEDGERS;

pub fn get_config(env: &Env) -> Option<Config> {
    env.storage().instance().get(&DataKey::Config)
}

pub fn set_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_LIFETIME);
}

pub fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_LIFETIME);
}

pub fn get_stake(env: &Env, lp: &Address) -> StakeInfo {
    let key = DataKey::Stake(lp.clone());
    match env.storage().persistent().get::<DataKey, StakeInfo>(&key) {
        Some(info) => {
            env.storage()
                .persistent()
                .extend_ttl(&key, STAKE_BUMP_THRESHOLD, STAKE_LIFETIME);
            info
        }
        None => StakeInfo { staked: 0, unbonding: 0, unbond_available_at: 0 },
    }
}

pub fn set_stake(env: &Env, lp: &Address, info: &StakeInfo) {
    let key = DataKey::Stake(lp.clone());
    env.storage().persistent().set(&key, info);
    env.storage()
        .persistent()
        .extend_ttl(&key, STAKE_BUMP_THRESHOLD, STAKE_LIFETIME);
}

pub fn slashed_so_far(env: &Env, trade_id: &soroban_sdk::BytesN<32>) -> i128 {
    let key = DataKey::Slashed(trade_id.clone());
    match env.storage().persistent().get::<DataKey, i128>(&key) {
        Some(v) => {
            env.storage()
                .persistent()
                .extend_ttl(&key, SLASHED_BUMP_THRESHOLD, SLASHED_LIFETIME);
            v
        }
        None => 0,
    }
}

pub fn add_slashed(env: &Env, trade_id: &soroban_sdk::BytesN<32>, amount: i128) {
    let key = DataKey::Slashed(trade_id.clone());
    let total = env
        .storage()
        .persistent()
        .get::<DataKey, i128>(&key)
        .unwrap_or(0)
        + amount;
    env.storage().persistent().set(&key, &total);
    env.storage()
        .persistent()
        .extend_ttl(&key, SLASHED_BUMP_THRESHOLD, SLASHED_LIFETIME);
}

