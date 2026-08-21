#![allow(dead_code)]
use soroban_sdk::{contractevent, Address};

#[contractevent]
pub struct Staked {
    #[topic]
    pub lp: Address,
    pub amount: i128,
    pub total_staked: i128,
}

#[contractevent]
pub struct UnstakeRequested {
    #[topic]
    pub lp: Address,
    pub amount: i128,
    pub available_at: u64,
}

#[contractevent]
pub struct Unstaked {
    #[topic]
    pub lp: Address,
    pub amount: i128,
}

#[contractevent]
pub struct Slashed {
    #[topic]
    pub lp: Address,
    #[topic]
    pub victim: Address,
    pub amount: i128,
}

#[contractevent]
pub struct ConfigChanged {
    #[topic]
    pub admin: Address,
    pub resolver: Address,
}

#[contractevent]
pub struct PausedSet {
    pub paused: bool,
}
