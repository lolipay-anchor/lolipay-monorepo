#![allow(dead_code)]

use soroban_sdk::{contractevent, Address, BytesN};

#[contractevent]
pub struct TradeCreated {
    #[topic]
    pub trade_id: BytesN<32>,
    pub usdc_amount: i128,
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

#[contractevent]
pub struct FiatPaid {
    #[topic]
    pub trade_id: BytesN<32>,
}

#[contractevent]
pub struct Released {
    #[topic]
    pub trade_id: BytesN<32>,
    pub net: i128,
    pub platform_fee: i128,
    pub lp_fee: i128,
}

#[contractevent]
pub struct Refunded {
    #[topic]
    pub trade_id: BytesN<32>,
    pub amount: i128,
}

#[contractevent]
pub struct Disputed {
    #[topic]
    pub trade_id: BytesN<32>,
    pub by: Address,
}

#[contractevent]
pub struct Resolved {
    #[topic]
    pub trade_id: BytesN<32>,
    pub released: bool,
    pub post_settle: bool,
}
