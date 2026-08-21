#![cfg(test)]
use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, token, Address, BytesN, Env, Symbol};

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
        self.escrow.create_trade(
            &trade_id, &self.user, &self.lp, &self.user, &1_000_000_000i128, &1_600_000i128,
            &Symbol::new(&self.env, "IDR"), &Flow::Withdraw, &30u32, &120u32,
            &self.platform_wallet, &self.lp_wallet, &1000u64, &2000u64, &3000u64,
        );
        if dispute {
            self.escrow.mark_fiat_paid(&trade_id);
            self.escrow.raise_dispute(&trade_id, &self.user);
        }
        trade_id
    }

    fn make_settled_trade(&self, id: u8) -> BytesN<32> {
        self.usdc_admin.mint(&self.user, &1_000_000_000i128);
        let trade_id = id32(&self.env, id);
        self.escrow.create_trade(
            &trade_id, &self.user, &self.lp, &self.user, &1_000_000_000i128, &1_600_000i128,
            &Symbol::new(&self.env, "IDR"), &Flow::Withdraw, &30u32, &120u32,
            &self.platform_wallet, &self.lp_wallet, &1000u64, &2000u64, &3000u64,
        );
        self.escrow.mark_fiat_paid(&trade_id);
        self.env.ledger().with_mut(|li| {
            li.timestamp = 500;
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
        (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, platform_wallet.clone(), 3600u64),
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

    let trade_id = s.make_settled_trade(9);
    assert_eq!(s.escrow.get_trade(&trade_id).status, Status::Released);
    assert_eq!(s.usdc.balance(&s.lp), 985_000_000i128);
    assert_eq!(s.usdc.balance(&s.user), 0);

    s.escrow.raise_dispute(&trade_id, &s.user);
    assert_eq!(s.escrow.get_trade(&trade_id).status, Status::Disputed);
    let (is_disputed, provider, recipient, amount) = s.escrow.dispute_view(&trade_id);
    assert!(is_disputed);
    assert_eq!(provider, s.user);
    assert_eq!(recipient, s.lp);
    assert_eq!(amount, 1_000_000_000i128);

    s.staking.slash(&s.lp, &trade_id, &500_000_000i128, &s.resolver);
    assert_eq!(s.usdc.balance(&s.user), 500_000_000i128);
    assert_eq!(s.staking.get_stake(&s.lp).staked, 1_500_000_000i128);
    assert_eq!(s.escrow.get_trade(&trade_id).status, Status::Disputed);

    assert_eq!(
        s.staking.try_slash(&s.lp, &trade_id, &1i128, &s.resolver),
        Err(Ok(Error::AlreadySlashed))
    );
    assert_eq!(s.usdc.balance(&s.user), 500_000_000i128);
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
    let (is_disputed, _, _, _) = s.escrow.dispute_view(&trade_id);
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
