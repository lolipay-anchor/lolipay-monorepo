use soroban_sdk::{contracterror, contracttype, Address, BytesN, Symbol, Vec};

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Funded = 0,
    FiatPaid = 1,
    Released = 2,
    Refunded = 3,
    Disputed = 4,
}

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Flow {
    TopUp = 0,
    Withdraw = 1,
}

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ResolveOutcome {
    Release = 0,
    Refund = 1,
}

#[contracttype]
#[derive(Clone)]
pub struct Trade {
    pub status: Status,
    pub usdc_provider: Address,
    pub usdc_recipient: Address,
    pub confirmer: Address,
    pub usdc_token: Address,
    pub usdc_amount: i128,
    pub fiat_amount: i128,
    pub fiat_currency: Symbol,
    pub flow: Flow,
    pub platform_fee_bps: u32,
    pub lp_fee_bps: u32,
    pub platform_wallet: Address,
    pub lp_wallet: Address,
    pub created_at: u64,
    pub pay_deadline: u64,
    pub confirm_deadline: u64,
    pub dispute_deadline: u64,
    pub disputed_by: Option<Address>,
    pub resolver_deadline: u64,
    pub settled_at: u64,
    pub has_pre_dispute_status: bool,
    pub pre_dispute_status: Status,
    pub provider_post_settle_used: bool,
    pub recipient_post_settle_used: bool,
    pub resolver_post_settle_used: bool,
    pub post_settle_deadline: u64,
    pub slash_deadline: u64,
    pub liability_established: bool,
    pub dispute_window: u64,
}

impl Trade {
    pub fn pre_dispute_status(&self) -> Option<Status> {
        if self.has_pre_dispute_status {
            Some(self.pre_dispute_status)
        } else {
            None
        }
    }

    pub fn set_pre_dispute_status(&mut self, status: Option<Status>) {
        match status {
            Some(s) => {
                self.has_pre_dispute_status = true;
                self.pre_dispute_status = s;
            }
            None => {
                self.has_pre_dispute_status = false;
                self.pre_dispute_status = Status::Funded;
            }
        }
    }
}

#[contracttype]
#[derive(Clone)]
pub struct DisputeView {
    pub is_disputed: bool,
    pub provider: Address,
    pub recipient: Address,
    pub amount: i128,
    pub pre_settlement: bool,
    pub released: bool,
    pub post_settle_raised: bool,
    pub liability_established: bool,
    pub slash_deadline: u64,
    pub collateral_hold_until: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct Config {
    pub admin: Address,
    pub usdc_token: Address,
    pub resolver: Address,
    pub default_platform_fee_bps: u32,
    pub default_platform_wallet: Address,
    pub paused: bool,
    pub dispute_window: u64,
    pub fiat_attestor: Address,
    pub early_release_providers: Vec<Address>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Trade(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Paused = 3,
    TradeExists = 4,
    TradeNotFound = 5,
    InvalidAmount = 6,
    InvalidFee = 7,
    InvalidDeadlines = 8,
    InvalidState = 9,
    DeadlinePassed = 10,
    DeadlineNotReached = 11,
    Unauthorized = 12,
    NotDisputed = 13,
    TokenImmutable = 14,
    WalletImmutable = 15,
    InvalidRoles = 16,
    InvalidConfig = 17,
    DisputeWindowPassed = 18,
    AlreadyResolved = 19,
    EarlyReleaseNotAllowed = 20,
    DisputeNotAllowed = 21,
}
