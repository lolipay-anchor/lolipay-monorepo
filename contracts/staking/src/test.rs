#![cfg(test)]
use soroban_sdk::{testutils::Address as _, testutils::Events as _, testutils::Ledger as _, testutils::MockAuth, testutils::MockAuthInvoke, token, Address, BytesN, Env, Event, IntoVal, Symbol};

use crate::types::{Config, Error};
use crate::{StakingContract, StakingContractClient};
use lolipay_escrow::types::{Flow, ResolveOutcome, Status};
use lolipay_escrow::{EscrowContract, EscrowContractClient};

fn id32(env: &Env, n: u8) -> BytesN<32> {
    let mut b = [0u8; 32];
    b[31] = n;
    BytesN::from_array(env, &b)
}

struct SlashEnv {
    env: Env,
    staking: StakingContractClient<'static>,
    escrow: EscrowContractClient<'static>,
    usdc: token::TokenClient<'static>,
    usdc_admin: token::StellarAssetClient<'static>,
    resolver: Address,
    admin: Address,
    lp: Address,
    user: Address,
    platform_wallet: Address,
    lp_wallet: Address,
    trade_id: BytesN<32>,
}

impl SlashEnv {
    fn make_trade(&self, id: u8, dispute: bool) -> BytesN<32> {
        self.usdc_admin.mint(&self.user, &1_000_000_000i128);
        let trade_id = id32(&self.env, id);
        let now = self.env.ledger().timestamp();
        self.escrow.create_trade(
            &trade_id, &self.user, &self.lp, &self.user, &1_000_000_000i128, &1_600_000i128,
            &Symbol::new(&self.env, "IDR"), &Flow::Withdraw, &30u32, &120u32,
            &self.platform_wallet, &self.lp_wallet, &(now + 1000), &(now + 2000), &(now + 3000),
        );
        if dispute {
            self.escrow.mark_fiat_paid(&trade_id, &self.lp);
            self.env.ledger().with_mut(|li| {
                li.timestamp = now + 500;
            });
            self.escrow.confirm_and_release(&trade_id);
            self.escrow.raise_dispute(&trade_id, &self.user);
        }
        trade_id
    }

    fn make_topup_trade(&self, id: u8) -> BytesN<32> {
        self.usdc_admin.mint(&self.lp, &1_000_000_000i128);
        let trade_id = id32(&self.env, id);
        let now = self.env.ledger().timestamp();
        self.escrow.create_trade(
            &trade_id, &self.lp, &self.user, &self.lp, &1_000_000_000i128, &1_600_000i128,
            &Symbol::new(&self.env, "IDR"), &Flow::TopUp, &30u32, &120u32,
            &self.platform_wallet, &self.lp_wallet, &(now + 1000), &(now + 2000), &(now + 3000),
        );
        trade_id
    }

    fn make_settled_trade(&self, id: u8) -> BytesN<32> {
        let now = self.env.ledger().timestamp();
        self.make_trade(id, false);
        let trade_id = id32(&self.env, id);
        self.escrow.mark_fiat_paid(&trade_id, &self.lp);
        self.env.ledger().with_mut(|li| {
            li.timestamp = now + 500;
        });
        self.escrow.confirm_and_release(&trade_id);
        trade_id
    }
}

fn slash_setup() -> SlashEnv {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let platform_wallet = Address::generate(&env);
    let lp_wallet = Address::generate(&env);
    let user = Address::generate(&env);
    let lp = Address::generate(&env);

    let escrow_id = env.register(
        EscrowContract,
        (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, platform_wallet.clone(), 3600u64, Address::generate(&env)),
    );
    let escrow = EscrowContractClient::new(&env, &escrow_id);
    let staking_id = env.register(
        StakingContract,
        (admin.clone(), usdc.address.clone(), resolver.clone(), escrow_id.clone(), 1_000_000_000i128, 100u64),
    );
    let staking = StakingContractClient::new(&env, &staking_id);

    let temp_id = id32(&env, 0);
    let mut s = SlashEnv {
        env,
        staking,
        escrow,
        usdc,
        usdc_admin,
        resolver,
        admin,
        lp,
        user,
        platform_wallet,
        lp_wallet,
        trade_id: temp_id,
    };
    s.trade_id = s.make_trade(7, true);
    s
}

fn setup() -> (Env, StakingContractClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let usdc = Address::generate(&env);
    let resolver = Address::generate(&env);
    let escrow = Address::generate(&env);
    let contract_id = env.register(
        StakingContract,
        (admin.clone(), usdc.clone(), resolver.clone(), escrow.clone(), 1_000_000_000i128, 100u64),
    );
    let client = StakingContractClient::new(&env, &contract_id);
    (env, client, admin, usdc, resolver)
}

#[test]
fn test_initialize_and_config() {
    let (_e, client, admin, usdc, resolver) = setup();
    let cfg = client.get_config();
    assert_eq!(cfg.admin, admin);
    assert_eq!(cfg.usdc_token, usdc);
    assert_eq!(cfg.resolver, resolver);
    assert_eq!(cfg.min_stake, 1_000_000_000i128);
    assert_eq!(cfg.cooldown_secs, 100);
    assert!(!cfg.paused);
}

#[test]
fn test_set_paused_and_non_admin_rejected() {
    let (env, client, _admin, _usdc, _resolver) = setup();
    client.set_paused(&true);
    assert!(client.get_config().paused);
    client.set_paused(&false);
    assert!(!client.get_config().paused);
    env.set_auths(&[]);
    assert!(matches!(client.try_set_paused(&true), Err(Err(_))));
}

#[test]
fn test_set_config_updates_fields() {
    let (env, client, admin, usdc, _resolver) = setup();
    let new_resolver = Address::generate(&env);
    let new_config = Config {
        admin: admin.clone(),
        usdc_token: usdc.clone(),
        resolver: new_resolver.clone(),
        escrow_contract: client.get_config().escrow_contract,
        min_stake: 5_000_000_000i128,
        cooldown_secs: 200,
        paused: false,
    };
    client.set_config(&new_config);
    let cfg = client.get_config();
    assert_eq!(cfg.resolver, new_resolver);
    assert_eq!(cfg.min_stake, 5_000_000_000i128);
    assert_eq!(cfg.cooldown_secs, 200);
    assert_eq!(cfg.admin, admin);
    assert_eq!(cfg.usdc_token, usdc);
}

#[test]
fn test_set_config_non_admin_rejected() {
    let (env, client, admin, usdc, resolver) = setup();
    let new_config = Config {
        admin: admin.clone(),
        usdc_token: usdc.clone(),
        resolver: resolver.clone(),
        escrow_contract: client.get_config().escrow_contract,
        min_stake: 5_000_000_000i128,
        cooldown_secs: 200,
        paused: false,
    };
    env.set_auths(&[]);
    assert!(matches!(client.try_set_config(&new_config), Err(Err(_))));
    assert_eq!(client.get_config().min_stake, 1_000_000_000i128);
}

#[test]
fn test_set_config_cannot_change_token() {
    let (env, client, admin, usdc, usdc_admin, resolver) = setup_with_usdc();
    let lp = Address::generate(&env);
    usdc_admin.mint(&lp, &1_000_000_000i128);
    client.stake(&lp, &1_000_000_000i128);

    let other_token = Address::generate(&env);
    let bad_config = Config {
        admin: admin.clone(),
        usdc_token: other_token,
        resolver: resolver.clone(),
        escrow_contract: client.get_config().escrow_contract,
        min_stake: 1_000_000_000i128,
        cooldown_secs: 100,
        paused: false,
    };
    assert_eq!(client.try_set_config(&bad_config), Err(Ok(Error::TokenImmutable)));
    assert_eq!(client.get_config().usdc_token, usdc.address);

    let good_config = Config {
        admin: admin.clone(),
        usdc_token: usdc.address.clone(),
        resolver: resolver.clone(),
        escrow_contract: client.get_config().escrow_contract,
        min_stake: 7_000_000_000i128,
        cooldown_secs: 100,
        paused: false,
    };
    client.set_config(&good_config);
    assert_eq!(client.get_config().min_stake, 7_000_000_000i128);
    assert_eq!(client.get_config().usdc_token, usdc.address);
}

#[test]
fn test_set_config_handoff_to_new_admin() {
    let (env, client, _admin, usdc, _resolver) = setup();
    let new_admin = Address::generate(&env);
    let new_resolver = Address::generate(&env);
    let new_config = Config {
        admin: new_admin.clone(),
        usdc_token: usdc.clone(),
        resolver: new_resolver,
        escrow_contract: client.get_config().escrow_contract,
        min_stake: 1_000_000_000i128,
        cooldown_secs: 100,
        paused: false,
    };
    client.set_config(&new_config);
    assert_eq!(client.get_config().admin, new_admin);
}

fn create_usdc(
    env: &Env,
    admin: &Address,
) -> (token::TokenClient<'static>, token::StellarAssetClient<'static>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    (
        token::TokenClient::new(env, &sac.address()),
        token::StellarAssetClient::new(env, &sac.address()),
    )
}

fn setup_with_usdc() -> (
    Env,
    StakingContractClient<'static>,
    Address,
    token::TokenClient<'static>,
    token::StellarAssetClient<'static>,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();
    let token_admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &token_admin);
    let admin = Address::generate(&env);
    let resolver = Address::generate(&env);
    let escrow = Address::generate(&env);
    let contract_id = env.register(
        StakingContract,
        (admin.clone(), usdc.address.clone(), resolver.clone(), escrow.clone(), 1_000_000_000i128, 100u64),
    );
    let client = StakingContractClient::new(&env, &contract_id);
    (env, client, admin, usdc, usdc_admin, resolver)
}

#[test]
fn test_stake_pulls_usdc_and_sets_eligible() {
    let (env, client, _admin, usdc, usdc_admin, _resolver) = setup_with_usdc();
    let lp = Address::generate(&env);
    usdc_admin.mint(&lp, &2_000_000_000i128);
    let contract_id = client.address.clone();

    client.stake(&lp, &1_000_000_000i128);
    assert_eq!(usdc.balance(&lp), 1_000_000_000i128);
    assert_eq!(usdc.balance(&contract_id), 1_000_000_000i128);
    assert_eq!(client.get_stake(&lp).staked, 1_000_000_000i128);
    assert!(client.is_eligible(&lp));
}

#[test]
fn test_stake_rejects_zero_and_paused() {
    let (env, client, _admin, usdc, usdc_admin, _resolver) = setup_with_usdc();
    let lp = Address::generate(&env);
    usdc_admin.mint(&lp, &1_000_000_000i128);
    assert_eq!(client.try_stake(&lp, &0i128), Err(Ok(Error::InvalidAmount)));
    client.set_paused(&true);
    assert_eq!(client.try_stake(&lp, &1_000_000_000i128), Err(Ok(Error::Paused)));
    let _ = usdc;
}

#[test]
fn test_is_eligible_default_false() {
    let (_e, client, _admin, _usdc, _resolver) = setup();
    let lp = Address::generate(&_e);
    assert!(!client.is_eligible(&lp));
    let info = client.get_stake(&lp);
    assert_eq!(info.staked, 0);
    assert_eq!(info.unbonding, 0);
}

#[test]
fn test_request_then_claim_after_cooldown() {
    let (env, client, _admin, usdc, usdc_admin, _resolver) = setup_with_usdc();
    let lp = Address::generate(&env);
    usdc_admin.mint(&lp, &2_000_000_000i128);
    client.stake(&lp, &2_000_000_000i128);

    client.request_unstake(&lp, &1_000_000_000i128);
    let info = client.get_stake(&lp);
    assert_eq!(info.staked, 1_000_000_000i128);
    assert_eq!(info.unbonding, 1_000_000_000i128);
    assert!(client.is_eligible(&lp));

    assert_eq!(client.try_claim_unstake(&lp), Err(Ok(Error::CooldownActive)));

    env.ledger().with_mut(|li| { li.timestamp = 200; });
    client.claim_unstake(&lp);
    assert_eq!(usdc.balance(&lp), 1_000_000_000i128);
    let info2 = client.get_stake(&lp);
    assert_eq!(info2.unbonding, 0);
    assert_eq!(info2.staked, 1_000_000_000i128);
}

#[test]
fn test_request_unstake_rejects_over_staked_and_claim_nothing() {
    let (env, client, _admin, _usdc, usdc_admin, _resolver) = setup_with_usdc();
    let lp = Address::generate(&env);
    usdc_admin.mint(&lp, &1_000_000_000i128);
    client.stake(&lp, &1_000_000_000i128);
    assert_eq!(client.try_request_unstake(&lp, &2_000_000_000i128), Err(Ok(Error::InsufficientStaked)));
    assert_eq!(client.try_request_unstake(&lp, &0i128), Err(Ok(Error::InvalidAmount)));
    assert_eq!(client.try_claim_unstake(&lp), Err(Ok(Error::NothingToClaim)));
}

#[test]
fn test_slash_bound_to_disputed_trade_pays_counterparty() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &2_000_000_000i128);
    s.staking.stake(&s.lp, &2_000_000_000i128);
    assert_eq!(s.usdc.balance(&s.user), 0);

    s.staking.slash(&s.lp, &s.trade_id, &500_000_000i128, &s.resolver);
    assert_eq!(s.usdc.balance(&s.user), 500_000_000i128);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_500_000_000i128);
    assert_eq!(
        s.staking.try_slash(&s.lp, &s.trade_id, &1i128, &s.resolver),
        Err(Ok(Error::AlreadySlashed))
    );
}

#[test]
fn test_slash_reaches_unbonding() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    s.staking.request_unstake(&s.lp, &1_000_000_000i128);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 0);
    s.staking.slash(&s.lp, &s.trade_id, &1_000_000_000i128, &s.resolver);
    assert_eq!(s.usdc.balance(&s.user), 1_000_000_000i128);
    let info = s.staking.get_stake(&s.lp);
    assert_eq!(info.staked, 0);
    assert_eq!(info.unbonding, 0);
}

#[test]
fn test_slash_guards_amount_party_and_caller() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);

    assert_eq!(
        s.staking.try_slash(&s.lp, &s.trade_id, &2_000_000_000i128, &s.resolver),
        Err(Ok(Error::InvalidAmount))
    );
    let outsider = Address::generate(&s.env);
    s.usdc_admin.mint(&outsider, &1_000_000_000i128);
    s.staking.stake(&outsider, &1_000_000_000i128);
    assert_eq!(
        s.staking.try_slash(&outsider, &s.trade_id, &100_000_000i128, &s.resolver),
        Err(Ok(Error::NotTradeParty))
    );
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.staking.try_slash(&s.lp, &s.trade_id, &100_000_000i128, &stranger),
        Err(Ok(Error::Unauthorized))
    );
    s.staking.slash(&s.lp, &s.trade_id, &100_000_000i128, &s.admin);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 900_000_000i128);
}

#[test]
fn test_slash_rejects_undisputed_trade() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let undisputed = s.make_trade(8, false);
    assert_eq!(
        s.staking.try_slash(&s.lp, &undisputed, &100_000_000i128, &s.resolver),
        Err(Ok(Error::TradeNotDisputed))
    );
}

#[test]
fn test_slash_works_while_paused() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    s.staking.set_paused(&true);
    s.staking.slash(&s.lp, &s.trade_id, &1_000_000_000i128, &s.resolver);
    assert_eq!(s.usdc.balance(&s.user), 1_000_000_000i128);
}

#[test]
fn test_slash_rejected_after_trade_resolved() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    s.escrow.resolve(&s.trade_id, &ResolveOutcome::Refund, &s.resolver);
    assert_eq!(
        s.staking.try_slash(&s.lp, &s.trade_id, &100_000_000i128, &s.resolver),
        Err(Ok(Error::TradeNotDisputed))
    );
}

#[test]
fn test_slash_partial_spill_staked_then_unbonding() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    s.staking.request_unstake(&s.lp, &500_000_000i128);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 500_000_000i128);
    s.staking.slash(&s.lp, &s.trade_id, &700_000_000i128, &s.resolver);
    let info = s.staking.get_stake(&s.lp);
    assert_eq!(info.staked, 0);
    assert_eq!(info.unbonding, 300_000_000i128);
    assert_eq!(s.usdc.balance(&s.user), 700_000_000i128);
}

#[test]
fn test_slash_post_settlement_full_flow_and_one_shot() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &2_000_000_000i128);
    s.staking.stake(&s.lp, &2_000_000_000i128);

    let lp_before = s.usdc.balance(&s.lp);
    let user_before = s.usdc.balance(&s.user);
    let trade_id = s.make_settled_trade(9);
    assert_eq!(s.escrow.get_trade(&trade_id).status, Status::Released);
    assert_eq!(s.usdc.balance(&s.lp), lp_before + 985_000_000i128);
    assert_eq!(s.usdc.balance(&s.user), user_before);

    s.escrow.raise_dispute(&trade_id, &s.user);
    assert_eq!(s.escrow.get_trade(&trade_id).status, Status::Disputed);
    let v = s.escrow.dispute_view(&trade_id);
    let (is_disputed, provider, recipient, amount) = (v.is_disputed, v.provider, v.recipient, v.amount);
    assert!(is_disputed);
    assert_eq!(provider, s.user);
    assert_eq!(recipient, s.lp);
    assert_eq!(amount, 1_000_000_000i128);

    s.staking.slash(&s.lp, &trade_id, &500_000_000i128, &s.resolver);
    assert_eq!(s.usdc.balance(&s.user), user_before + 500_000_000i128);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_500_000_000i128);
    assert_eq!(s.escrow.get_trade(&trade_id).status, Status::Disputed);

    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &1i128, &s.resolver),
        Err(Ok(Error::AlreadySlashed))
    );
    assert_eq!(s.usdc.balance(&s.user), user_before + 500_000_000i128);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_500_000_000i128);
}

#[test]
fn test_slash_rejected_after_post_settlement_resolve_proves_ordering() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);

    let trade_id = s.make_settled_trade(10);
    s.escrow.raise_dispute(&trade_id, &s.user);
    assert_eq!(s.escrow.get_trade(&trade_id).status, Status::Disputed);

    s.escrow.resolve(&trade_id, &ResolveOutcome::Release, &s.resolver);
    assert_eq!(s.escrow.get_trade(&trade_id).status, Status::Released);
    let is_disputed = s.escrow.dispute_view(&trade_id).is_disputed;
    assert!(!is_disputed);

    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &100_000_000i128, &s.resolver),
        Err(Ok(Error::TradeNotDisputed))
    );
    assert_eq!(s.usdc.balance(&s.user), 0);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_000_000_000i128);
}

#[test]
fn test_slash_post_settlement_cap_rejects_amount_above_trade_value() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);

    let trade_id = s.make_settled_trade(11);
    s.escrow.raise_dispute(&trade_id, &s.user);

    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &2_000_000_000i128, &s.resolver),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(s.usdc.balance(&s.user), 0);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_000_000_000i128);
}

#[test]
fn test_request_unstake_accumulates_and_resets_timer() {
    let (env, client, _admin, _usdc, usdc_admin, _resolver) = setup_with_usdc();
    let lp = Address::generate(&env);
    usdc_admin.mint(&lp, &2_000_000_000i128);
    client.stake(&lp, &2_000_000_000i128);

    let t1 = 1_000u64;
    env.ledger().with_mut(|li| { li.timestamp = t1; });
    client.request_unstake(&lp, &500_000_000i128);
    assert_eq!(client.get_stake(&lp).unbonding, 500_000_000i128);
    assert_eq!(client.get_stake(&lp).unbond_available_at, t1 + 100);

    let t2 = 1_050u64;
    env.ledger().with_mut(|li| { li.timestamp = t2; });
    client.request_unstake(&lp, &500_000_000i128);

    let info = client.get_stake(&lp);
    assert_eq!(info.unbonding, 1_000_000_000i128);
    assert_eq!(info.unbond_available_at, t2 + 100);
    assert_eq!(info.staked, 1_000_000_000i128);
}

fn staked_lp() -> (
    Env, StakingContractClient<'static>, Address, Address, Address, Address,
) {
    let env = Env::default();
    env.mock_all_auths();
    let token_admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &token_admin);
    let admin = Address::generate(&env);
    let resolver = Address::generate(&env);
    let escrow = Address::generate(&env);
    let contract_id = env.register(
        StakingContract,
        (admin.clone(), usdc.address.clone(), resolver.clone(), escrow.clone(), 1_000_000_000i128, 100u64),
    );
    let client = StakingContractClient::new(&env, &contract_id);
    let lp = Address::generate(&env);
    usdc_admin.mint(&lp, &10_000_000_000i128);
    client.stake(&lp, &4_000_000_000i128);
    (env, client, admin, resolver, lp, escrow)
}

#[test]
fn a_reservation_reduces_what_is_available() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    assert_eq!(client.available(&lp), 4_000_000_000i128);

    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);

    assert_eq!(client.available(&lp), 3_000_000_000i128);
    assert_eq!(client.get_stake(&lp).staked, 4_000_000_000i128);
}

#[test]
fn two_reservations_cannot_exceed_the_stake() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &3_000_000_000i128, &resolver);

    let res = client.try_reserve(&lp, &id32(&env, 2), &1_500_000_000i128, &resolver);

    assert_eq!(res, Err(Ok(Error::InsufficientAvailable)));
    assert_eq!(client.available(&lp), 1_000_000_000i128);
}

#[test]
fn a_reservation_may_take_exactly_what_is_left() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &3_000_000_000i128, &resolver);

    client.reserve(&lp, &id32(&env, 2), &1_000_000_000i128, &resolver);

    assert_eq!(client.available(&lp), 0);
}

#[test]
fn releasing_a_reservation_restores_availability() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);

    client.release_reservation(&lp, &id32(&env, 1), &resolver);

    assert_eq!(client.available(&lp), 4_000_000_000i128);
}

#[test]
fn a_reservation_is_idempotent_per_trade() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);

    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);

    assert_eq!(client.available(&lp), 3_000_000_000i128);
}

#[test]
fn releasing_a_reservation_that_was_never_made_is_refused() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();

    let res = client.try_release_reservation(&lp, &id32(&env, 9), &resolver);

    assert_eq!(res, Err(Ok(Error::ReservationNotFound)));
}

#[test]
fn releasing_twice_is_refused_so_the_total_cannot_go_negative() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);
    client.release_reservation(&lp, &id32(&env, 1), &resolver);

    let res = client.try_release_reservation(&lp, &id32(&env, 1), &resolver);

    assert_eq!(res, Err(Ok(Error::ReservationNotFound)));
    assert_eq!(client.available(&lp), 4_000_000_000i128);
}

#[test]
fn unstaking_cannot_take_reserved_collateral() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &3_000_000_000i128, &resolver);

    let res = client.try_request_unstake(&lp, &2_000_000_000i128);

    assert_eq!(res, Err(Ok(Error::InsufficientAvailable)));
    assert_eq!(client.get_stake(&lp).staked, 4_000_000_000i128);
}

#[test]
fn unstaking_the_unreserved_part_still_works() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &3_000_000_000i128, &resolver);

    client.request_unstake(&lp, &1_000_000_000i128);

    assert_eq!(client.get_stake(&lp).staked, 3_000_000_000i128);
    assert_eq!(client.available(&lp), 0);
}

#[test]
fn eligibility_reads_available_not_staked() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    assert!(client.is_eligible(&lp));

    client.reserve(&lp, &id32(&env, 1), &3_500_000_000i128, &resolver);

    assert!(!client.is_eligible(&lp));
}

#[test]
fn a_stranger_cannot_reserve_a_providers_stake() {
    let (env, client, _a, _resolver, lp, _e) = staked_lp();
    let stranger = Address::generate(&env);

    let res = client.try_reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &stranger);

    assert_eq!(res, Err(Ok(Error::Unauthorized)));
    assert_eq!(client.available(&lp), 4_000_000_000i128);
}

#[test]
fn a_provider_cannot_reserve_or_release_their_own_collateral() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);

    assert_eq!(
        client.try_reserve(&lp, &id32(&env, 2), &1_000_000_000i128, &lp),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_release_reservation(&lp, &id32(&env, 1), &lp),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(client.available(&lp), 3_000_000_000i128);
}

#[test]
fn the_admin_may_reserve_and_release_as_well_as_the_resolver() {
    let (env, client, admin, _resolver, lp, _e) = staked_lp();

    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &admin);
    assert_eq!(client.available(&lp), 3_000_000_000i128);

    client.release_reservation(&lp, &id32(&env, 1), &admin);
    assert_eq!(client.available(&lp), 4_000_000_000i128);
}

#[test]
fn naming_the_resolver_is_not_the_same_as_being_the_resolver() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();

    env.set_auths(&[]);
    let res = client.try_reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);

    assert!(res.is_err());
    assert_eq!(client.available(&lp), 4_000_000_000i128);
}

#[test]
fn a_reservation_of_nothing_is_refused() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();

    assert_eq!(
        client.try_reserve(&lp, &id32(&env, 1), &0i128, &resolver),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        client.try_reserve(&lp, &id32(&env, 2), &-1i128, &resolver),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn pausing_stops_collateral_being_freed_by_the_resolver() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);
    client.set_paused(&true);

    assert_eq!(
        client.try_release_reservation(&lp, &id32(&env, 1), &resolver),
        Err(Ok(Error::Paused))
    );
    assert_eq!(client.available(&lp), 3_000_000_000i128);
}

#[test]
fn slashing_consumes_the_reservation_for_that_trade() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_trade(1, true);
    s.staking.reserve(&s.lp, &trade_id, &500_000_000i128, &s.resolver);
    let before = s.staking.available(&s.lp);

    s.staking.slash(&s.lp, &trade_id, &500_000_000i128, &s.resolver);

    let info = s.staking.get_stake(&s.lp);
    assert_eq!(info.reserved, 0);
    assert_eq!(s.staking.available(&s.lp), info.staked);
    let _ = before;
}


#[test]
fn a_funded_origin_dispute_is_not_grounds_to_slash() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &2_000_000_000i128);
    s.staking.stake(&s.lp, &2_000_000_000i128);
    let trade_id = s.make_topup_trade(77);
    s.escrow.raise_dispute(&trade_id, &s.resolver);
    let before = s.usdc.balance(&s.user);

    let res = s.staking.try_slash(&s.lp, &trade_id, &500_000_000i128, &s.resolver);

    assert_eq!(res, Err(Ok(Error::SlashNotApplicable)));
    assert_eq!(s.usdc.balance(&s.user), before);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 2_000_000_000i128);
}

#[test]
fn a_fiat_paid_dispute_is_not_grounds_to_slash_while_the_escrow_still_holds_it() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &2_000_000_000i128);
    s.staking.stake(&s.lp, &2_000_000_000i128);
    let trade_id = s.make_trade(88, false);
    s.escrow.mark_fiat_paid(&trade_id, &s.lp);
    s.escrow.raise_dispute(&trade_id, &s.user);
    let user_before = s.usdc.balance(&s.user);
    let lp_before = s.usdc.balance(&s.lp);
    let escrow_before = s.usdc.balance(&s.escrow.address);
    assert_eq!(escrow_before, 1_000_000_000i128);

    let res = s.staking.try_slash(&s.lp, &trade_id, &1_000_000_000i128, &s.resolver);

    assert_eq!(res, Err(Ok(Error::SlashNotApplicable)));
    assert_eq!(s.usdc.balance(&s.user), user_before);
    assert_eq!(s.usdc.balance(&s.escrow.address), escrow_before);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 2_000_000_000i128);

    s.escrow.resolve(&trade_id, &ResolveOutcome::Release, &s.resolver);
    assert_eq!(s.usdc.balance(&s.lp), lp_before + 985_000_000i128);
    assert_eq!(s.usdc.balance(&s.escrow.address), 0);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 2_000_000_000i128);
}

#[test]
fn a_slash_never_forgives_another_trades_commitment() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &2_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let a = s.make_trade(11, true);
    let b = s.make_trade(12, true);
    s.staking.reserve(&s.lp, &a, &900_000_000i128, &s.resolver);

    s.staking.slash(&s.lp, &b, &900_000_000i128, &s.resolver);

    assert_eq!(s.staking.get_stake(&s.lp).reserved, 900_000_000i128);
    assert_eq!(s.staking.available(&s.lp), 0);
    assert_eq!(
        s.staking.try_reserve(&s.lp, &id32(&s.env, 13), &1i128, &s.resolver),
        Err(Ok(Error::InsufficientAvailable))
    );
}

#[test]
fn availability_never_reports_a_negative_number() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &2_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let a = s.make_trade(21, true);
    let b = s.make_trade(22, true);
    s.staking.reserve(&s.lp, &a, &900_000_000i128, &s.resolver);

    s.staking.slash(&s.lp, &b, &900_000_000i128, &s.resolver);

    assert_eq!(s.staking.available(&s.lp), 0);
}

#[test]
fn a_larger_second_reservation_takes_the_difference_rather_than_being_ignored() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &1i128, &resolver);

    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);

    assert_eq!(client.get_reservation(&lp, &id32(&env, 1)), Some(1_000_000_000i128));
    assert_eq!(client.available(&lp), 3_000_000_000i128);
}

#[test]
fn a_smaller_second_reservation_is_refused_rather_than_silently_accepted() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);

    let res = client.try_reserve(&lp, &id32(&env, 1), &1i128, &resolver);

    assert_eq!(res, Err(Ok(Error::InvalidAmount)));
    assert_eq!(client.get_reservation(&lp, &id32(&env, 1)), Some(1_000_000_000i128));
}

#[test]
fn an_equal_second_reservation_is_still_a_no_op() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);

    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);

    assert_eq!(client.available(&lp), 3_000_000_000i128);
}

#[test]
fn pausing_stops_new_commitments_as_well_as_releases() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    client.set_paused(&true);

    assert_eq!(
        client.try_reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver),
        Err(Ok(Error::Paused))
    );
}

#[test]
fn the_admin_can_free_collateral_even_while_paused() {
    let (env, client, admin, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);
    client.set_paused(&true);

    client.force_release_reservation(&lp, &id32(&env, 1), &admin);

    assert_eq!(client.available(&lp), 4_000_000_000i128);
}

#[test]
fn only_the_admin_may_force_a_release() {
    let (env, client, _admin, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);

    assert_eq!(
        client.try_force_release_reservation(&lp, &id32(&env, 1), &resolver),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_force_release_reservation(&lp, &id32(&env, 1), &lp),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn naming_the_resolver_is_not_enough_to_release_either() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);

    env.set_auths(&[]);
    let res = client.try_release_reservation(&lp, &id32(&env, 1), &resolver);

    assert!(res.is_err());
    assert_eq!(client.available(&lp), 3_000_000_000i128);
}

#[test]
fn releasing_one_reservation_leaves_the_other_committed() {
    let (env, client, _a, resolver, lp, _e) = staked_lp();
    client.reserve(&lp, &id32(&env, 1), &1_000_000_000i128, &resolver);
    client.reserve(&lp, &id32(&env, 2), &1_000_000_000i128, &resolver);

    client.release_reservation(&lp, &id32(&env, 1), &resolver);

    assert_eq!(client.get_stake(&lp).reserved, 1_000_000_000i128);
    assert_eq!(client.get_reservation(&lp, &id32(&env, 2)), Some(1_000_000_000i128));
}

#[test]
fn a_slashed_trades_reservation_is_gone_not_merely_uncounted() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &2_000_000_000i128);
    s.staking.stake(&s.lp, &2_000_000_000i128);
    let trade_id = s.make_trade(31, true);
    s.staking.reserve(&s.lp, &trade_id, &500_000_000i128, &s.resolver);

    s.staking.slash(&s.lp, &trade_id, &500_000_000i128, &s.resolver);

    assert_eq!(s.staking.get_reservation(&s.lp, &trade_id), None);
    assert_eq!(
        s.staking.try_release_reservation(&s.lp, &trade_id, &s.resolver),
        Err(Ok(Error::ReservationNotFound))
    );
}

#[test]
fn a_slashed_trade_can_never_be_reserved_against_again() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &2_000_000_000i128);
    s.staking.stake(&s.lp, &2_000_000_000i128);
    let trade_id = s.make_trade(41, true);
    s.staking.slash(&s.lp, &trade_id, &500_000_000i128, &s.resolver);

    let res = s.staking.try_reserve(&s.lp, &trade_id, &100_000_000i128, &s.resolver);

    assert_eq!(res, Err(Ok(Error::AlreadySlashed)));
    assert_eq!(s.staking.get_reservation(&s.lp, &trade_id), None);
}

#[test]
fn naming_the_resolver_is_not_the_same_as_being_the_resolver_when_slashing() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &2_000_000_000i128);
    s.staking.stake(&s.lp, &2_000_000_000i128);
    let stranger = Address::generate(&s.env);
    let before = s.usdc.balance(&s.user);

    s.env.set_auths(&[]);
    let res = s
        .staking
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &s.staking.address,
                fn_name: "slash",
                args: (s.lp.clone(), s.trade_id.clone(), 500_000_000i128, s.resolver.clone())
                    .into_val(&s.env),
                sub_invokes: &[],
            },
        }])
        .try_slash(&s.lp, &s.trade_id, &500_000_000i128, &s.resolver);

    assert!(res.is_err());
    assert_eq!(s.usdc.balance(&s.user), before);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 2_000_000_000i128);
}

#[test]
fn set_config_needs_the_sitting_admins_signature_not_the_incoming_ones() {
    let (env, client, _admin, _usdc, _resolver) = setup();
    let usurper = Address::generate(&env);
    let mut cfg = client.get_config();
    cfg.admin = usurper.clone();

    env.set_auths(&[]);
    let res = client
        .mock_auths(&[MockAuth {
            address: &usurper,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "set_config",
                args: (cfg.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_config(&cfg);

    assert!(res.is_err());
    assert_ne!(client.get_config().admin, usurper);
}

#[test]
fn naming_the_admin_is_not_the_same_as_being_the_admin_when_freeing_collateral() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &2_000_000_000i128);
    s.staking.stake(&s.lp, &2_000_000_000i128);
    s.staking.reserve(&s.lp, &s.trade_id, &500_000_000i128, &s.resolver);
    let stranger = Address::generate(&s.env);

    s.env.set_auths(&[]);
    let res = s
        .staking
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &s.staking.address,
                fn_name: "force_release_reservation",
                args: (s.lp.clone(), s.trade_id.clone(), s.admin.clone()).into_val(&s.env),
                sub_invokes: &[],
            },
        }])
        .try_force_release_reservation(&s.lp, &s.trade_id, &s.admin);

    assert!(res.is_err());
    assert_eq!(s.staking.get_stake(&s.lp).reserved, 500_000_000i128);
}

#[test]
fn unstaking_needs_the_lps_own_signature() {
    let (env, client, _admin, _usdc, usdc_admin, _resolver) = setup_with_usdc();
    let lp = Address::generate(&env);
    usdc_admin.mint(&lp, &2_000_000_000i128);
    client.stake(&lp, &2_000_000_000i128);
    let stranger = Address::generate(&env);

    env.set_auths(&[]);
    let requested = client
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "request_unstake",
                args: (lp.clone(), 1_000_000_000i128).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_request_unstake(&lp, &1_000_000_000i128);

    assert!(requested.is_err());
    assert_eq!(client.get_stake(&lp).staked, 2_000_000_000i128);
}

#[test]
fn claiming_an_unstake_needs_the_lps_own_signature() {
    let (env, client, _admin, _usdc, usdc_admin, _resolver) = setup_with_usdc();
    let lp = Address::generate(&env);
    usdc_admin.mint(&lp, &2_000_000_000i128);
    client.stake(&lp, &2_000_000_000i128);
    client.request_unstake(&lp, &1_000_000_000i128);
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    let stranger = Address::generate(&env);

    env.set_auths(&[]);
    let claimed = client
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "claim_unstake",
                args: (lp.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_claim_unstake(&lp);

    assert!(claimed.is_err());
    assert_eq!(client.get_stake(&lp).unbonding, 1_000_000_000i128);
}

#[test]
fn the_escrow_the_staking_contract_trusts_can_never_be_repointed() {
    let (_env, client, _admin, _usdc, _resolver) = setup();
    let original = client.get_config().escrow_contract.clone();
    let mut cfg = client.get_config();
    cfg.escrow_contract = Address::generate(&_env);

    assert!(client.try_set_config(&cfg).is_err());
    assert_eq!(client.get_config().escrow_contract, original);
}

#[test]
fn a_slash_can_never_reach_past_one_lps_own_balance() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &400_000_000i128);
    s.staking.stake(&s.lp, &400_000_000i128);
    let other = Address::generate(&s.env);
    s.usdc_admin.mint(&other, &1_000_000_000i128);
    s.staking.stake(&other, &1_000_000_000i128);
    let pool_before = s.usdc.balance(&s.staking.address);
    let victim_before = s.usdc.balance(&s.user);

    let res = s
        .staking
        .try_slash(&s.lp, &s.trade_id, &500_000_000i128, &s.resolver);

    assert_eq!(res, Err(Ok(Error::InsufficientStake)));
    assert_eq!(s.usdc.balance(&s.staking.address), pool_before);
    assert_eq!(s.usdc.balance(&s.user), victim_before);
    assert_eq!(s.staking.get_stake(&other).staked, 1_000_000_000i128);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 400_000_000i128);
}

#[test]
fn topping_a_reservation_up_takes_only_the_difference_at_the_boundary() {
    let (env, client, _admin, _usdc, usdc_admin, resolver) = setup_with_usdc();
    let lp = Address::generate(&env);
    usdc_admin.mint(&lp, &1_000_000_000i128);
    client.stake(&lp, &1_000_000_000i128);
    let trade = id32(&env, 5);
    client.reserve(&lp, &trade, &600_000_000i128, &resolver);

    client.reserve(&lp, &trade, &1_000_000_000i128, &resolver);

    assert_eq!(client.get_stake(&lp).reserved, 1_000_000_000i128);
    assert_eq!(client.get_reservation(&lp, &trade), Some(1_000_000_000i128));
    assert_eq!(client.available(&lp), 0);
}

#[test]
fn the_admin_role_cannot_be_pushed_onto_an_address_that_never_consented() {
    let (env, client, admin, _usdc, _resolver) = setup();
    let unwilling = Address::generate(&env);
    let mut cfg = client.get_config();
    cfg.admin = unwilling.clone();

    env.set_auths(&[]);
    let res = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "set_config",
                args: (cfg.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_config(&cfg);

    assert!(res.is_err());
    assert_eq!(client.get_config().admin, admin);
}

#[test]
fn a_slash_reports_the_collateral_it_leaves_uncovered() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let other = id32(&s.env, 91);
    s.staking.reserve(&s.lp, &other, &800_000_000i128, &s.resolver);

    s.staking.slash(&s.lp, &s.trade_id, &1_000_000_000i128, &s.resolver);
    let raw = s.env.events().all().filter_by_contract(&s.staking.address);
    let raw = raw.events();
    let last = raw.last().unwrap().clone();

    let expected = crate::events::Slashed {
        lp: s.lp.clone(),
        victim: s.user.clone(),
        amount: 1_000_000_000i128,
        reservation_shortfall: 800_000_000i128,
    };
    assert_eq!(last, expected.to_xdr(&s.env, &s.staking.address));
    let info = s.staking.get_stake(&s.lp);
    assert_eq!(info.staked, 0);
    assert_eq!(info.reserved, 800_000_000i128);
}

#[test]
fn a_slash_that_covers_every_reservation_reports_no_shortfall() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &2_000_000_000i128);
    s.staking.stake(&s.lp, &2_000_000_000i128);
    s.staking.reserve(&s.lp, &s.trade_id, &500_000_000i128, &s.resolver);

    s.staking.slash(&s.lp, &s.trade_id, &500_000_000i128, &s.resolver);
    let raw = s.env.events().all().filter_by_contract(&s.staking.address);
    let raw = raw.events();
    let last = raw.last().unwrap().clone();

    let expected = crate::events::Slashed {
        lp: s.lp.clone(),
        victim: s.user.clone(),
        amount: 500_000_000i128,
        reservation_shortfall: 0i128,
    };
    assert_eq!(last, expected.to_xdr(&s.env, &s.staking.address));
    assert_eq!(s.staking.get_stake(&s.lp).reserved, 0);
}

#[test]
fn a_completed_trade_cannot_be_slashed_in_the_direction_the_money_went() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.user, &1_000_000_000i128);
    s.staking.stake(&s.user, &1_000_000_000i128);
    let trade_id = s.make_trade(51, true);
    let lp_before = s.usdc.balance(&s.lp);
    let user_stake_before = s.staking.get_stake(&s.user).staked;

    let res = s
        .staking
        .try_slash(&s.user, &trade_id, &1_000_000_000i128, &s.resolver);

    assert_eq!(res, Err(Ok(Error::SlashNotApplicable)));
    assert_eq!(s.usdc.balance(&s.lp), lp_before);
    assert_eq!(s.staking.get_stake(&s.user).staked, user_stake_before);
}

#[test]
fn a_released_trade_may_only_slash_whoever_received_the_money() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_trade(52, true);
    let victim_before = s.usdc.balance(&s.user);

    s.staking.slash(&s.lp, &trade_id, &400_000_000i128, &s.resolver);

    assert_eq!(s.usdc.balance(&s.user), victim_before + 400_000_000i128);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 600_000_000i128);
}

#[test]
fn a_refunded_trade_may_only_slash_whoever_got_their_capital_back() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    s.usdc_admin.mint(&s.user, &1_000_000_000i128);
    s.staking.stake(&s.user, &1_000_000_000i128);
    let now = s.env.ledger().timestamp();
    let trade_id = id32(&s.env, 53);
    s.usdc_admin.mint(&s.user, &1_000_000_000i128);
    s.escrow.create_trade(
        &trade_id, &s.user, &s.lp, &s.user, &1_000_000_000i128, &1_600_000i128,
        &Symbol::new(&s.env, "IDR"), &Flow::Withdraw, &30u32, &120u32,
        &s.platform_wallet, &s.lp_wallet, &(now + 1000), &(now + 2000), &(now + 3000),
    );
    s.env.ledger().with_mut(|li| li.timestamp = now + 2001);
    s.escrow.refund(&trade_id);
    s.escrow.raise_dispute(&trade_id, &s.lp);

    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &100_000_000i128, &s.resolver),
        Err(Ok(Error::SlashNotApplicable))
    );
    let victim_before = s.usdc.balance(&s.lp);
    s.staking.slash(&s.user, &trade_id, &100_000_000i128, &s.resolver);
    assert_eq!(s.usdc.balance(&s.lp), victim_before + 100_000_000i128);
}

#[test]
fn the_slash_right_dies_with_the_dispute_window_it_was_raised_in() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_trade(54, true);
    let deadline = s.escrow.dispute_view(&trade_id).slash_deadline;
    let victim_before = s.usdc.balance(&s.user);

    s.env.ledger().with_mut(|li| li.timestamp = deadline + 1);
    let res = s
        .staking
        .try_slash(&s.lp, &trade_id, &100_000_000i128, &s.resolver);

    assert_eq!(res, Err(Ok(Error::SlashWindowPassed)));
    assert_eq!(s.usdc.balance(&s.user), victim_before);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_000_000_000i128);

    s.env.ledger().with_mut(|li| li.timestamp = deadline);
    s.staking.slash(&s.lp, &trade_id, &100_000_000i128, &s.resolver);
    assert_eq!(s.usdc.balance(&s.user), victim_before + 100_000_000i128);
}

#[test]
fn collateral_is_freed_by_anyone_once_the_slash_window_has_closed() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_trade(55, true);
    s.staking.reserve(&s.lp, &trade_id, &1_000_000_000i128, &s.resolver);
    let deadline = s.escrow.dispute_view(&trade_id).slash_deadline;

    s.env.ledger().with_mut(|li| li.timestamp = deadline);
    assert_eq!(
        s.staking.try_release_expired_reservation(&s.lp, &trade_id),
        Err(Ok(Error::SlashWindowOpen))
    );
    assert_eq!(
        s.staking.try_request_unstake(&s.lp, &1_000_000_000i128),
        Err(Ok(Error::InsufficientAvailable))
    );

    s.env.ledger().with_mut(|li| li.timestamp = deadline + 1);
    s.staking.release_expired_reservation(&s.lp, &trade_id);

    assert_eq!(s.staking.get_stake(&s.lp).reserved, 0);
    assert_eq!(s.staking.get_reservation(&s.lp, &trade_id), None);
    s.staking.request_unstake(&s.lp, &1_000_000_000i128);
    assert_eq!(s.staking.get_stake(&s.lp).unbonding, 1_000_000_000i128);
}

#[test]
fn an_open_reservation_on_a_live_trade_is_never_freed_by_a_stranger() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let live = s.make_trade(56, false);
    s.staking.reserve(&s.lp, &live, &600_000_000i128, &s.resolver);

    assert_eq!(
        s.staking.try_release_expired_reservation(&s.lp, &live),
        Err(Ok(Error::SlashWindowOpen))
    );
    assert_eq!(s.staking.get_stake(&s.lp).reserved, 600_000_000i128);
}

#[test]
fn a_slash_survives_a_dispute_raised_at_the_very_last_second() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_trade(57, false);
    s.escrow.mark_fiat_paid(&trade_id, &s.lp);
    let now = s.env.ledger().timestamp();
    s.env.ledger().with_mut(|li| li.timestamp = now + 500);
    s.escrow.confirm_and_release(&trade_id);
    let window_end = s.escrow.get_trade(&trade_id).post_settle_deadline;

    s.env.ledger().with_mut(|li| li.timestamp = window_end);
    s.escrow.raise_dispute(&trade_id, &s.user);
    let victim_before = s.usdc.balance(&s.user);

    s.env.ledger().with_mut(|li| li.timestamp = window_end + 1);
    s.staking.slash(&s.lp, &trade_id, &500_000_000i128, &s.resolver);

    assert_eq!(s.usdc.balance(&s.user), victim_before + 500_000_000i128);
}

#[test]
fn collateral_stays_bound_while_a_dispute_can_still_be_raised() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_settled_trade(61);
    s.staking.reserve(&s.lp, &trade_id, &1_000_000_000i128, &s.resolver);
    let window_end = s.escrow.get_trade(&trade_id).post_settle_deadline;

    s.env.ledger().with_mut(|li| li.timestamp = window_end);
    assert_eq!(
        s.staking.try_release_expired_reservation(&s.lp, &trade_id),
        Err(Ok(Error::SlashWindowOpen))
    );
    assert_eq!(s.staking.get_stake(&s.lp).reserved, 1_000_000_000i128);

    s.escrow.raise_dispute(&trade_id, &s.user);
    let victim_before = s.usdc.balance(&s.user);
    s.staking.slash(&s.lp, &trade_id, &1_000_000_000i128, &s.resolver);
    assert_eq!(s.usdc.balance(&s.user), victim_before + 1_000_000_000i128);
}

#[test]
fn a_freed_reservation_can_never_be_followed_by_a_slash() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_settled_trade(62);
    s.staking.reserve(&s.lp, &trade_id, &1_000_000_000i128, &s.resolver);
    let window_end = s.escrow.get_trade(&trade_id).post_settle_deadline;

    s.env.ledger().with_mut(|li| li.timestamp = window_end + 1);
    s.staking.release_expired_reservation(&s.lp, &trade_id);
    assert_eq!(s.staking.get_stake(&s.lp).reserved, 0);

    assert_eq!(
        s.escrow.try_raise_dispute(&trade_id, &s.user),
        Err(Ok(lolipay_escrow::types::Error::DisputeWindowPassed))
    );
    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &1i128, &s.resolver),
        Err(Ok(Error::TradeNotDisputed))
    );
}

#[test]
fn an_unsettled_trade_never_gives_its_collateral_back() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_topup_trade(63);
    s.staking.reserve(&s.lp, &trade_id, &1_000_000_000i128, &s.resolver);
    s.escrow.raise_dispute(&trade_id, &s.resolver);
    let resolver_deadline = s.escrow.get_trade(&trade_id).resolver_deadline;

    s.env.ledger().with_mut(|li| li.timestamp = resolver_deadline + 1);

    assert_eq!(
        s.staking.try_release_expired_reservation(&s.lp, &trade_id),
        Err(Ok(Error::SlashWindowOpen))
    );
    assert_eq!(s.staking.get_stake(&s.lp).reserved, 1_000_000_000i128);
}

#[test]
fn a_reservation_against_a_trade_that_never_existed_is_never_a_hostage() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let ghost = id32(&s.env, 200);
    s.staking.reserve(&s.lp, &ghost, &1_000_000_000i128, &s.resolver);
    assert_eq!(s.staking.available(&s.lp), 0);

    s.staking.release_expired_reservation(&s.lp, &ghost);

    assert_eq!(s.staking.get_stake(&s.lp).reserved, 0);
    assert_eq!(s.staking.available(&s.lp), 1_000_000_000i128);
}
