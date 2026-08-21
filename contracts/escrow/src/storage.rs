#![allow(dead_code)]

use soroban_sdk::{BytesN, Env};

use crate::types::{Config, DataKey, Trade};

const DAY_IN_LEDGERS: u32 = 17280;
const TRADE_BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const TRADE_LIFETIME: u32 = 45 * DAY_IN_LEDGERS;
const INSTANCE_BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME: u32 = 90 * DAY_IN_LEDGERS;

pub fn get_config(env: &Env) -> Option<Config> {
    env.storage().instance().get(&DataKey::Config)
}

pub fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_LIFETIME);
}

pub fn set_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_LIFETIME);
}

pub fn has_trade(env: &Env, id: &BytesN<32>) -> bool {
    env.storage().persistent().has(&DataKey::Trade(id.clone()))
}

pub fn get_trade(env: &Env, id: &BytesN<32>) -> Option<Trade> {
    let key = DataKey::Trade(id.clone());
    let trade: Option<Trade> = env.storage().persistent().get(&key);
    if trade.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, TRADE_BUMP_THRESHOLD, TRADE_LIFETIME);
    }
    trade
}

pub fn set_trade(env: &Env, id: &BytesN<32>, trade: &Trade) {
    let key = DataKey::Trade(id.clone());
    env.storage().persistent().set(&key, trade);
    env.storage()
        .persistent()
        .extend_ttl(&key, TRADE_BUMP_THRESHOLD, TRADE_LIFETIME);
}

pub fn split_fees(amount: i128, platform_fee_bps: u32, lp_fee_bps: u32) -> (i128, i128, i128) {
    let platform_fee = amount * (platform_fee_bps as i128) / 10_000;
    let lp_fee = amount * (lp_fee_bps as i128) / 10_000;
    let net = amount - platform_fee - lp_fee;
    (platform_fee, lp_fee, net)
}
