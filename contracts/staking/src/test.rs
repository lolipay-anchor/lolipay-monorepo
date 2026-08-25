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
            self.escrow.resolve(&trade_id, &ResolveOutcome::Refund, &self.resolver);
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
        (admin.clone(), usdc.address.clone(), resolver.clone(), escrow_id.clone(), 1_000_000_000i128, 86_400u64),
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
        (admin.clone(), usdc.clone(), resolver.clone(), escrow.clone(), 1_000_000_000i128, 86_400u64),
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
    assert_eq!(cfg.cooldown_secs, 86_400);
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
        cooldown_secs: 172_800,
        paused: false,
    };
    client.set_config(&new_config);
    let cfg = client.get_config();
    assert_eq!(cfg.resolver, new_resolver);
    assert_eq!(cfg.min_stake, 5_000_000_000i128);
    assert_eq!(cfg.cooldown_secs, 172_800);
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
        cooldown_secs: 172_800,
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
        cooldown_secs: 86_400,
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
        cooldown_secs: 86_400,
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
        cooldown_secs: 86_400,
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
        (admin.clone(), usdc.address.clone(), resolver.clone(), escrow.clone(), 1_000_000_000i128, 86_400u64),
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

    env.ledger().with_mut(|li| { li.timestamp = 86_500; });
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
fn a_trade_the_escrow_still_holds_is_never_slashable() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let live = s.make_trade(8, false);
    assert_eq!(
        s.staking.try_slash(&s.lp, &live, &100_000_000i128, &s.resolver),
        Err(Ok(Error::SlashNotApplicable))
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
fn a_resolved_dispute_still_leaves_the_counterparty_whole() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let victim_before = s.usdc.balance(&s.user);

    s.staking.slash(&s.lp, &s.trade_id, &100_000_000i128, &s.resolver);

    assert_eq!(s.usdc.balance(&s.user), victim_before + 100_000_000i128);
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
    s.escrow.resolve(&trade_id, &ResolveOutcome::Refund, &s.resolver);
    assert_eq!(s.escrow.get_trade(&trade_id).status, Status::Released);
    let v = s.escrow.dispute_view(&trade_id);
    let (is_disputed, provider, recipient, amount) = (v.is_disputed, v.provider, v.recipient, v.amount);
    assert!(!is_disputed);
    assert_eq!(provider, s.user);
    assert_eq!(recipient, s.lp);
    assert_eq!(amount, 1_000_000_000i128);

    s.staking.slash(&s.lp, &trade_id, &500_000_000i128, &s.resolver);
    assert_eq!(s.usdc.balance(&s.user), user_before + 500_000_000i128);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_500_000_000i128);
    assert_eq!(s.escrow.get_trade(&trade_id).status, Status::Released);

    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &1i128, &s.resolver),
        Err(Ok(Error::AlreadySlashed))
    );
    assert_eq!(s.usdc.balance(&s.user), user_before + 500_000_000i128);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_500_000_000i128);
}

#[test]
fn a_verdict_against_the_settlement_still_leaves_the_remedy_hours_later() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);

    let trade_id = s.make_settled_trade(10);
    let settled = s.escrow.get_trade(&trade_id).settled_at;
    s.env.ledger().with_mut(|li| li.timestamp = settled + 3000);
    s.escrow.raise_dispute(&trade_id, &s.user);

    s.env.ledger().with_mut(|li| li.timestamp = settled + 40_000);
    s.escrow.resolve(&trade_id, &ResolveOutcome::Refund, &s.resolver);
    assert_eq!(s.escrow.get_trade(&trade_id).status, Status::Released);
    assert!(!s.escrow.dispute_view(&trade_id).is_disputed);

    s.staking.slash(&s.lp, &trade_id, &100_000_000i128, &s.resolver);

    assert_eq!(s.usdc.balance(&s.user), 100_000_000i128);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 900_000_000i128);
}

#[test]
fn a_verdict_upholding_the_settlement_ends_the_exposure_at_once() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);

    let trade_id = s.make_settled_trade(11);
    s.escrow.raise_dispute(&trade_id, &s.user);
    s.escrow.resolve(&trade_id, &ResolveOutcome::Release, &s.resolver);

    assert_eq!(s.escrow.dispute_view(&trade_id).slash_deadline, 0);
    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &1i128, &s.resolver),
        Err(Ok(Error::NoLiabilityFound))
    );
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_000_000_000i128);
}

#[test]
fn a_resolver_raised_dispute_carries_the_same_remedy_as_a_partys() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_settled_trade(97);
    let settled = s.escrow.get_trade(&trade_id).settled_at;

    s.escrow.raise_dispute(&trade_id, &s.resolver);
    s.env.ledger().with_mut(|li| li.timestamp = settled + 40_000);
    s.escrow.resolve(&trade_id, &ResolveOutcome::Refund, &s.resolver);

    s.staking.slash(&s.lp, &trade_id, &100_000_000i128, &s.resolver);
    assert_eq!(s.usdc.balance(&s.user), 100_000_000i128);
}

#[test]
fn a_dispute_that_happened_before_settlement_never_arms_a_slash() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_trade(98, false);
    s.escrow.mark_fiat_paid(&trade_id, &s.lp);
    s.escrow.raise_dispute(&trade_id, &s.user);
    s.escrow.resolve(&trade_id, &ResolveOutcome::Release, &s.resolver);

    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &1i128, &s.resolver),
        Err(Ok(Error::TradeNotDisputed))
    );
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_000_000_000i128);
}

#[test]
fn a_trade_that_was_never_disputed_after_settling_is_never_slashable() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_settled_trade(12);

    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &1i128, &s.resolver),
        Err(Ok(Error::TradeNotDisputed))
    );
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_000_000_000i128);
}

#[test]
fn the_slash_right_still_dies_with_the_window_after_a_verdict() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_settled_trade(13);
    s.escrow.raise_dispute(&trade_id, &s.user);
    s.escrow.resolve(&trade_id, &ResolveOutcome::Refund, &s.resolver);
    let deadline = s.escrow.dispute_view(&trade_id).slash_deadline;
    assert!(s.escrow.dispute_view(&trade_id).liability_established);

    s.env.ledger().with_mut(|li| li.timestamp = deadline + 1);

    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &1i128, &s.resolver),
        Err(Ok(Error::SlashWindowPassed))
    );
}

#[test]
fn test_slash_post_settlement_cap_rejects_amount_above_trade_value() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);

    let trade_id = s.make_settled_trade(11);
    s.escrow.raise_dispute(&trade_id, &s.user);
    s.escrow.resolve(&trade_id, &ResolveOutcome::Refund, &s.resolver);

    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &2_000_000_000i128, &s.resolver),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(s.usdc.balance(&s.user), 0);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_000_000_000i128);
}

#[test]
fn test_request_unstake_accumulates_and_extends_the_timer() {
    let (env, client, _admin, _usdc, usdc_admin, _resolver) = setup_with_usdc();
    let lp = Address::generate(&env);
    usdc_admin.mint(&lp, &2_000_000_000i128);
    client.stake(&lp, &2_000_000_000i128);

    let t1 = 1_000u64;
    env.ledger().with_mut(|li| { li.timestamp = t1; });
    client.request_unstake(&lp, &500_000_000i128);
    assert_eq!(client.get_stake(&lp).unbonding, 500_000_000i128);
    assert_eq!(client.get_stake(&lp).unbond_available_at, t1 + 86_400);

    let t2 = 1_050u64;
    env.ledger().with_mut(|li| { li.timestamp = t2; });
    client.request_unstake(&lp, &500_000_000i128);

    let info = client.get_stake(&lp);
    assert_eq!(info.unbonding, 1_000_000_000i128);
    assert_eq!(info.unbond_available_at, t2 + 86_400);
    assert_eq!(info.staked, 1_000_000_000i128);
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
    s.escrow.resolve(&trade_id, &ResolveOutcome::Release, &s.resolver);

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
    s.escrow.resolve(&trade_id, &ResolveOutcome::Refund, &s.resolver);
    let victim_before = s.usdc.balance(&s.user);

    s.env.ledger().with_mut(|li| li.timestamp = window_end + 1);
    s.staking.slash(&s.lp, &trade_id, &500_000_000i128, &s.resolver);

    assert_eq!(s.usdc.balance(&s.user), victim_before + 500_000_000i128);
}

#[test]
fn a_user_who_paid_before_cosigning_a_cancel_still_has_a_remedy() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let now = s.env.ledger().timestamp();
    let trade_id = id32(&s.env, 70);
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.escrow.create_trade(
        &trade_id, &s.lp, &s.user, &s.lp, &1_000_000_000i128, &1_600_000i128,
        &Symbol::new(&s.env, "IDR"), &Flow::TopUp, &30u32, &120u32,
        &s.platform_wallet, &s.lp_wallet, &(now + 1000), &(now + 2000), &(now + 3000),
    );
    let lp_before = s.usdc.balance(&s.lp);

    s.env.ledger().with_mut(|li| li.timestamp = now + 10);
    s.escrow.cancel(&trade_id);
    assert_eq!(s.escrow.get_trade(&trade_id).status, Status::Refunded);
    assert_eq!(s.usdc.balance(&s.lp), lp_before + 1_000_000_000i128);
    let cancelled = s.escrow.get_trade(&trade_id);
    assert_eq!(cancelled.post_settle_deadline, cancelled.settled_at + 3600);

    s.env.ledger().with_mut(|li| li.timestamp = now + 1800);
    s.escrow.raise_dispute(&trade_id, &s.user);
    s.escrow.resolve(&trade_id, &ResolveOutcome::Release, &s.resolver);
    let user_before = s.usdc.balance(&s.user);
    s.staking.slash(&s.lp, &trade_id, &1_000_000_000i128, &s.resolver);

    assert_eq!(s.usdc.balance(&s.user), user_before + 1_000_000_000i128);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 0);
}

#[test]
fn upholding_a_cancellation_clears_the_provider_at_once() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let now = s.env.ledger().timestamp();
    let trade_id = id32(&s.env, 71);
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.escrow.create_trade(
        &trade_id, &s.lp, &s.user, &s.lp, &1_000_000_000i128, &1_600_000i128,
        &Symbol::new(&s.env, "IDR"), &Flow::TopUp, &30u32, &120u32,
        &s.platform_wallet, &s.lp_wallet, &(now + 1000), &(now + 2000), &(now + 3000),
    );
    s.env.ledger().with_mut(|li| li.timestamp = now + 10);
    s.escrow.cancel(&trade_id);
    s.escrow.raise_dispute(&trade_id, &s.user);

    s.escrow.resolve(&trade_id, &ResolveOutcome::Refund, &s.resolver);

    assert_eq!(s.escrow.dispute_view(&trade_id).slash_deadline, 0);
    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &1i128, &s.resolver),
        Err(Ok(Error::NoLiabilityFound))
    );
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_000_000_000i128);
}

#[soroban_sdk::contract]
pub struct SulkingEscrow;

#[soroban_sdk::contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SulkError {
    NotInitialized = 2,
}

#[soroban_sdk::contractimpl]
impl SulkingEscrow {
    pub fn dispute_view(_env: Env, _trade_id: BytesN<32>) -> Result<crate::types::DisputeView, SulkError> {
        Err(SulkError::NotInitialized)
    }
}

#[test]
fn a_holder_who_files_and_wins_does_not_thereby_arm_its_own_confiscation() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_settled_trade(230);
    let psd = s.escrow.get_trade(&trade_id).post_settle_deadline;

    s.env.ledger().with_mut(|li| li.timestamp = psd);
    s.escrow.raise_dispute(&trade_id, &s.lp);
    s.escrow.resolve(&trade_id, &ResolveOutcome::Release, &s.resolver);

    let victim_before = s.usdc.balance(&s.user);
    s.env.ledger().with_mut(|li| li.timestamp = psd + 1);
    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &1_000_000_000i128, &s.resolver),
        Err(Ok(Error::NoLiabilityFound))
    );

    assert_eq!(s.usdc.balance(&s.user), victim_before);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_000_000_000i128);
}

#[test]
fn a_later_dispute_the_holder_wins_still_establishes_no_liability() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_settled_trade(231);

    s.escrow.raise_dispute(&trade_id, &s.user);
    s.escrow.resolve(&trade_id, &ResolveOutcome::Release, &s.resolver);
    assert_eq!(s.escrow.dispute_view(&trade_id).slash_deadline, 0);

    let now = s.env.ledger().timestamp();
    s.env.ledger().with_mut(|li| li.timestamp = now + 1200);
    s.escrow.raise_dispute(&trade_id, &s.lp);
    s.escrow.resolve(&trade_id, &ResolveOutcome::Release, &s.resolver);

    let view = s.escrow.dispute_view(&trade_id);
    assert!(!view.liability_established);
    assert_ne!(view.slash_deadline, 0);

    let victim_before = s.usdc.balance(&s.user);
    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &1_000_000_000i128, &s.resolver),
        Err(Ok(Error::NoLiabilityFound))
    );
    assert_eq!(s.usdc.balance(&s.user), victim_before);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_000_000_000i128);
}

#[test]
fn one_party_cannot_spend_the_others_right_to_be_heard() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_settled_trade(231);

    s.escrow.raise_dispute(&trade_id, &s.lp);
    s.escrow.resolve(&trade_id, &ResolveOutcome::Release, &s.resolver);

    s.escrow.raise_dispute(&trade_id, &s.user);

    let t = s.escrow.get_trade(&trade_id);
    assert!(t.recipient_post_settle_used);
    assert!(t.provider_post_settle_used);
    assert!(!t.resolver_post_settle_used);
}

#[test]
fn a_verdict_acted_on_late_still_leaves_time_to_act_on_it() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_settled_trade(232);
    let psd = s.escrow.get_trade(&trade_id).post_settle_deadline;
    s.escrow.raise_dispute(&trade_id, &s.user);
    let resolver_deadline = s.escrow.get_trade(&trade_id).resolver_deadline;

    s.env.ledger().with_mut(|li| li.timestamp = resolver_deadline + 1);
    s.escrow.resolve(&trade_id, &ResolveOutcome::Refund, &s.admin);
    assert!(s.escrow.dispute_view(&trade_id).slash_deadline >= psd);

    s.env.ledger().with_mut(|li| li.timestamp = resolver_deadline + 3600);
    let victim_before = s.usdc.balance(&s.user);
    s.staking.slash(&s.lp, &trade_id, &500_000_000i128, &s.resolver);
    assert_eq!(s.usdc.balance(&s.user), victim_before + 500_000_000i128);

    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &1i128, &s.resolver),
        Err(Ok(Error::AlreadySlashed))
    );
}

#[test]
fn every_settlement_route_binds_the_collateral_it_creates() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &4_000_000_000i128);
    s.staking.stake(&s.lp, &4_000_000_000i128);

    let refunded = s.make_trade(240, false);
    let now = s.env.ledger().timestamp();
    s.env.ledger().with_mut(|li| li.timestamp = now + 2001);
    s.escrow.refund(&refunded);
    let t = s.escrow.get_trade(&refunded);
    assert_ne!(t.slash_deadline, 0);
    assert_eq!(t.slash_deadline, t.post_settle_deadline);

    let resolved = s.make_trade(241, false);
    s.escrow.mark_fiat_paid(&resolved, &s.lp);
    s.escrow.raise_dispute(&resolved, &s.user);
    s.escrow.resolve(&resolved, &ResolveOutcome::Release, &s.resolver);
    let t = s.escrow.get_trade(&resolved);
    assert_ne!(t.slash_deadline, 0);
    assert_eq!(t.slash_deadline, t.post_settle_deadline);

    let confirmed = s.make_settled_trade(242);
    let t = s.escrow.get_trade(&confirmed);
    assert_ne!(t.slash_deadline, 0);
    assert_eq!(t.slash_deadline, t.post_settle_deadline);

    let cancelled = s.make_trade(243, false);
    s.escrow.cancel(&cancelled);
    let t = s.escrow.get_trade(&cancelled);
    assert_ne!(t.slash_deadline, 0);
    assert_eq!(t.slash_deadline, t.post_settle_deadline);
}

#[test]
fn the_escrow_error_code_this_contract_trusts_is_still_the_one_it_means() {
    assert_eq!(lolipay_escrow::types::Error::TradeNotFound as u32, crate::ESCROW_TRADE_NOT_FOUND);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn a_cooldown_shorter_than_a_day_is_refused_at_construction() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let usdc = Address::generate(&env);
    let resolver = Address::generate(&env);
    let escrow = Address::generate(&env);

    env.register(
        StakingContract,
        (admin, usdc, resolver, escrow, 1_000_000_000i128, 300u64),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn a_zero_cooldown_is_refused_too() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let usdc = Address::generate(&env);
    let resolver = Address::generate(&env);
    let escrow = Address::generate(&env);

    env.register(
        StakingContract,
        (admin, usdc, resolver, escrow, 1_000_000_000i128, 0u64),
    );
}

#[test]
fn the_cooldown_can_never_be_configured_below_the_floor_afterwards() {
    let (_env, client, _admin, _usdc, _resolver) = setup();
    let mut cfg = client.get_config();
    cfg.cooldown_secs = 300;

    assert_eq!(client.try_set_config(&cfg), Err(Ok(Error::InvalidCooldown)));
    assert_eq!(client.get_config().cooldown_secs, 86_400);

    let mut cfg = client.get_config();
    cfg.cooldown_secs = 0;
    assert_eq!(client.try_set_config(&cfg), Err(Ok(Error::InvalidCooldown)));
}

#[test]
fn the_cooldown_ceiling_is_ninety_days() {
    let (_env, client, _admin, _usdc, _resolver) = setup();
    let mut cfg = client.get_config();
    cfg.cooldown_secs = 90 * 24 * 60 * 60;
    client.set_config(&cfg);
    assert_eq!(client.get_config().cooldown_secs, 7_776_000);

    let mut cfg = client.get_config();
    cfg.cooldown_secs = 7_776_001;
    assert_eq!(client.try_set_config(&cfg), Err(Ok(Error::InvalidCooldown)));
}

#[test]
fn no_stake_moves_before_a_verdict_has_been_rendered() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_settled_trade(180);
    s.escrow.raise_dispute(&trade_id, &s.resolver);
    let victim_before = s.usdc.balance(&s.user);

    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &1_000_000_000i128, &s.resolver),
        Err(Ok(Error::VerdictPending))
    );
    assert_eq!(s.usdc.balance(&s.user), victim_before);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_000_000_000i128);

    s.escrow.resolve(&trade_id, &ResolveOutcome::Refund, &s.resolver);
    s.staking.slash(&s.lp, &trade_id, &1_000_000_000i128, &s.resolver);
    assert_eq!(s.usdc.balance(&s.user), victim_before + 1_000_000_000i128);
}

#[test]
fn lowering_the_cooldown_never_releases_what_is_already_unbonding() {
    let (env, client, admin, _usdc, usdc_admin, _resolver) = setup_with_usdc();
    let lp = Address::generate(&env);
    usdc_admin.mint(&lp, &2_000_000_000i128);
    client.stake(&lp, &2_000_000_000i128);
    let mut cfg = client.get_config();
    cfg.cooldown_secs = 7_776_000;
    cfg.admin = admin.clone();
    client.set_config(&cfg);

    client.request_unstake(&lp, &1_999_999_999i128);
    let locked_until = client.get_stake(&lp).unbond_available_at;

    let mut cfg = client.get_config();
    cfg.cooldown_secs = 86_400;
    client.set_config(&cfg);
    client.request_unstake(&lp, &1i128);
    let raw = env.events().all().filter_by_contract(&client.address);
    let raw = raw.events();
    let last = raw.last().unwrap().clone();

    assert_eq!(client.get_stake(&lp).unbond_available_at, locked_until);
    let expected = crate::events::UnstakeRequested {
        lp: lp.clone(),
        amount: 1i128,
        available_at: locked_until,
    };
    assert_eq!(last, expected.to_xdr(&env, &client.address));
}

#[test]
fn a_slash_that_empties_the_unbonding_pool_takes_its_deadline_with_it() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let mut cfg = s.staking.get_config();
    cfg.cooldown_secs = 7_776_000;
    s.staking.set_config(&cfg);
    let trade_id = s.make_trade(215, true);

    s.staking.request_unstake(&s.lp, &1_000_000_000i128);
    assert_ne!(s.staking.get_stake(&s.lp).unbond_available_at, 0);

    s.staking.slash(&s.lp, &trade_id, &1_000_000_000i128, &s.resolver);

    let info = s.staking.get_stake(&s.lp);
    assert_eq!(info.unbonding, 0);
    assert_eq!(info.unbond_available_at, 0);
}

#[test]
fn available_is_simply_what_is_staked() {
    let (env, client, _admin, _usdc, usdc_admin, _resolver) = setup_with_usdc();
    let lp = Address::generate(&env);
    usdc_admin.mint(&lp, &3_000_000_000i128);
    client.stake(&lp, &3_000_000_000i128);

    assert_eq!(client.available(&lp), 3_000_000_000i128);
    client.request_unstake(&lp, &1_000_000_000i128);
    assert_eq!(client.available(&lp), 2_000_000_000i128);
    assert_eq!(client.get_stake(&lp).unbonding, 1_000_000_000i128);
}

#[test]
fn an_escrow_that_will_not_answer_stops_a_slash_rather_than_allowing_one() {
    let env = Env::default();
    env.mock_all_auths();
    let token_admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &token_admin);
    let admin = Address::generate(&env);
    let resolver = Address::generate(&env);
    let sulking = env.register(SulkingEscrow, ());
    let staking_id = env.register(
        StakingContract,
        (admin, usdc.address.clone(), resolver.clone(), sulking, 1_000_000_000i128, 86_400u64),
    );
    let staking = StakingContractClient::new(&env, &staking_id);
    let lp = Address::generate(&env);
    usdc_admin.mint(&lp, &1_000_000_000i128);
    staking.stake(&lp, &1_000_000_000i128);

    assert_eq!(
        staking.try_slash(&lp, &id32(&env, 220), &1i128, &resolver),
        Err(Ok(Error::EscrowUnreadable))
    );
    assert_eq!(staking.get_stake(&lp).staked, 1_000_000_000i128);
}

#[test]
fn each_kind_of_entry_keeps_the_lifetime_its_access_pattern_needs() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);
    let trade_id = s.make_trade(212, false);

    let day = 17_280u32;
    let addr = s.staking.address.clone();
    s.env.as_contract(&addr, || {
        use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
        assert_eq!(s.env.storage().instance().get_ttl(), 90 * day);
        assert_eq!(
            s.env.storage().persistent().get_ttl(&crate::types::DataKey::Stake(s.lp.clone())),
            90 * day
        );
    });

    s.escrow.mark_fiat_paid(&trade_id, &s.lp);
    let now = s.env.ledger().timestamp();
    s.env.ledger().with_mut(|li| li.timestamp = now + 500);
    s.escrow.confirm_and_release(&trade_id);
    s.escrow.raise_dispute(&trade_id, &s.user);
    s.escrow.resolve(&trade_id, &ResolveOutcome::Refund, &s.resolver);
    s.staking.slash(&s.lp, &trade_id, &100_000_000i128, &s.resolver);

    s.env.as_contract(&addr, || {
        use soroban_sdk::testutils::storage::Persistent as _;
        assert_eq!(
            s.env.storage().persistent().get_ttl(&crate::types::DataKey::Slashed(trade_id.clone())),
            90 * day
        );
    });
}

#[test]
fn a_bond_one_unit_below_the_minimum_does_not_make_a_provider_eligible() {
    let (env, client, _admin, _usdc, usdc_admin, _resolver) = setup_with_usdc();
    let lp = Address::generate(&env);
    usdc_admin.mint(&lp, &2_000_000_000i128);

    client.stake(&lp, &999_999_999i128);
    assert_eq!(client.get_stake(&lp).staked, 999_999_999i128);
    assert!(!client.is_eligible(&lp));

    client.stake(&lp, &1i128);
    assert_eq!(client.get_stake(&lp).staked, 1_000_000_000i128);
    assert!(client.is_eligible(&lp));
}

#[test]
fn a_slash_names_the_victim_it_paid_and_the_amount_it_took() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);

    s.staking.slash(&s.lp, &s.trade_id, &400_000_000i128, &s.resolver);
    let raw = s.env.events().all().filter_by_contract(&s.staking.address);
    let raw = raw.events();
    let last = raw.last().unwrap().clone();

    let expected = crate::events::Slashed {
        lp: s.lp.clone(),
        victim: s.user.clone(),
        amount: 400_000_000i128,
    };
    assert_eq!(last, expected.to_xdr(&s.env, &s.staking.address));
}

#[test]
fn a_trade_the_escrow_has_never_heard_of_is_refused_rather_than_slashed() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &1_000_000_000i128);

    assert_eq!(
        s.staking.try_slash(&s.lp, &id32(&s.env, 250), &1i128, &s.resolver),
        Err(Ok(Error::TradeNotDisputed))
    );
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_000_000_000i128);
}

#[test]
fn a_slash_may_take_the_whole_bond_but_not_one_unit_more() {
    let s = slash_setup();
    s.usdc_admin.mint(&s.lp, &1_000_000_000i128);
    s.staking.stake(&s.lp, &600_000_000i128);
    s.staking.request_unstake(&s.lp, &200_000_000i128);

    let info = s.staking.get_stake(&s.lp);
    let whole_bond = info.staked + info.unbonding;
    assert_eq!(whole_bond, 600_000_000i128);

    assert_eq!(
        s.staking.try_slash(&s.lp, &s.trade_id, &(whole_bond + 1), &s.resolver),
        Err(Ok(Error::InsufficientStake))
    );
    s.staking.slash(&s.lp, &s.trade_id, &whole_bond, &s.resolver);
    let after = s.staking.get_stake(&s.lp);
    assert_eq!(after.staked, 0i128);
    assert_eq!(after.unbonding, 0i128);
}
