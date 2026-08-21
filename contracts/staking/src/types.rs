use soroban_sdk::{contracterror, contracttype, Address, BytesN};

#[contracttype]
#[derive(Clone)]
pub struct StakeInfo {
    pub staked: i128,
    pub unbonding: i128,
    pub unbond_available_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct Config {
    pub admin: Address,
    pub usdc_token: Address,
    pub resolver: Address,
    pub escrow_contract: Address,
    pub min_stake: i128,
    pub cooldown_secs: u64,
    pub paused: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Stake(Address),
    Slashed(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Paused = 3,
    InvalidAmount = 4,
    InsufficientStaked = 5,
    InsufficientStake = 6,
    NothingToClaim = 7,
    CooldownActive = 8,
    Unauthorized = 9,
    TokenImmutable = 10,
    InvalidCooldown = 11,
    TradeNotDisputed = 12,
    NotTradeParty = 13,
    AlreadySlashed = 14,
}
