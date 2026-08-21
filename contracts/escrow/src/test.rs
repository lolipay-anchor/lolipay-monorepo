#![cfg(test)]
use soroban_sdk::{testutils::{Address as _, Events as _, Ledger}, token, Address, BytesN, Env, Event, Symbol};

use crate::types::{Config, Error};
use crate::{EscrowContract, EscrowContractClient};

fn create_usdc(
    env: &Env,
    admin: &Address,
) -> (
    token::TokenClient<'static>,
    token::StellarAssetClient<'static>,
) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    (
        token::TokenClient::new(env, &sac.address()),
        token::StellarAssetClient::new(env, &sac.address()),
    )
}

fn id32(env: &Env, n: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[31] = n;
    BytesN::from_array(env, &bytes)
}

fn setup() -> (Env, EscrowContractClient<'static>, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let usdc = Address::generate(&env);
    let resolver = Address::generate(&env);
    let platform_wallet = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.clone(), resolver.clone(), 30u32, platform_wallet.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    (env, client, admin, usdc, resolver, platform_wallet)
}

#[test]
fn test_initialize_sets_config() {
    let (_env, client, admin, usdc, resolver, _platform_wallet) = setup();
    let cfg = client.get_config();
    assert_eq!(cfg.admin, admin);
    assert_eq!(cfg.usdc_token, usdc);
    assert_eq!(cfg.resolver, resolver);
    assert_eq!(cfg.default_platform_fee_bps, 30);
    assert!(!cfg.paused);
    assert_eq!(cfg.dispute_window, 3600);
}

#[test]
fn test_set_paused() {
    let (env, client, _admin, _usdc, _resolver, _platform_wallet) = setup();

    client.set_paused(&true);
    assert!(client.get_config().paused);

    client.set_paused(&false);
    assert!(!client.get_config().paused);

    env.set_auths(&[]);
    let res = client.try_set_paused(&true);
    assert!(res.is_err());
    assert!(!client.get_config().paused);
}

#[test]
fn test_set_config_updates_fields() {
    let (env, client, admin, usdc, resolver, platform_wallet) = setup();

    let new_resolver = Address::generate(&env);
    let new_cfg = Config {
        admin: admin.clone(),
        usdc_token: usdc.clone(),
        resolver: new_resolver.clone(),
        default_platform_fee_bps: 55,
        default_platform_wallet: platform_wallet.clone(),
        paused: false,
        dispute_window: 3600,
    };
    client.set_config(&new_cfg);

    let cfg = client.get_config();
    assert_eq!(cfg.resolver, new_resolver);
    assert_eq!(cfg.default_platform_fee_bps, 55);
    assert_eq!(cfg.admin, admin);

    env.set_auths(&[]);
    let rejected = Config {
        admin: admin.clone(),
        usdc_token: usdc.clone(),
        resolver: resolver.clone(),
        default_platform_fee_bps: 99,
        default_platform_wallet: platform_wallet.clone(),
        paused: false,
        dispute_window: 3600,
    };
    let res = client.try_set_config(&rejected);
    assert!(res.is_err());
    assert_eq!(client.get_config().default_platform_fee_bps, 55);
}

#[test]
fn test_set_config_handoff_requires_new_admin_auth() {
    let (env, client, admin, usdc, resolver, platform_wallet) = setup();

    let new_admin = Address::generate(&env);
    let handoff = Config {
        admin: new_admin.clone(),
        usdc_token: usdc.clone(),
        resolver: resolver.clone(),
        default_platform_fee_bps: 30,
        default_platform_wallet: platform_wallet.clone(),
        paused: false,
        dispute_window: 3600,
    };

    client.set_config(&handoff);
    assert_eq!(client.get_config().admin, new_admin);

    env.set_auths(&[]);
    let revert = Config {
        admin: admin.clone(),
        usdc_token: usdc.clone(),
        resolver: resolver.clone(),
        default_platform_fee_bps: 30,
        default_platform_wallet: platform_wallet.clone(),
        paused: false,
        dispute_window: 3600,
    };
    let res = client.try_set_config(&revert);
    assert!(res.is_err());
    assert_eq!(client.get_config().admin, new_admin);
}

#[test]
fn test_create_trade_locks_usdc() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let platform_wallet = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, platform_wallet.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);

    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lp_wallet = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);

    client.create_trade(
        &id32(&env, 1),
        &provider,
        &recipient,
        &provider,
        &100_0000000i128,
        &1_624_000i128,
        &Symbol::new(&env, "IDR"),
        &crate::types::Flow::TopUp,
        &30u32,
        &120u32,
        &platform_wallet,
        &lp_wallet,
        &1000u64,
        &2000u64,
        &3000u64,
    );

    assert_eq!(usdc.balance(&provider), 0);
    assert_eq!(usdc.balance(&contract_id), 100_0000000i128);
    let t = client.get_trade(&id32(&env, 1));
    assert_eq!(t.status, crate::types::Status::Funded);
    assert_eq!(t.usdc_amount, 100_0000000i128);
}

#[test]
fn test_create_trade_rejects_duplicate_and_bad_input() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);

    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");

    let res = client.try_create_trade(
        &id32(&env, 2),
        &p,
        &r,
        &p,
        &0i128,
        &1i128,
        &idr,
        &crate::types::Flow::TopUp,
        &30u32,
        &120u32,
        &pw,
        &lw,
        &1000u64,
        &2000u64,
        &3000u64,
    );
    assert_eq!(res, Err(Ok(Error::InvalidAmount)));

    let res = client.try_create_trade(
        &id32(&env, 3),
        &p,
        &r,
        &p,
        &10_0000000i128,
        &1i128,
        &idr,
        &crate::types::Flow::TopUp,
        &9000u32,
        &1000u32,
        &pw,
        &lw,
        &1000u64,
        &2000u64,
        &3000u64,
    );
    assert_eq!(res, Err(Ok(Error::InvalidFee)));

    let res = client.try_create_trade(
        &id32(&env, 4),
        &p,
        &r,
        &p,
        &10_0000000i128,
        &1i128,
        &idr,
        &crate::types::Flow::TopUp,
        &30u32,
        &120u32,
        &pw,
        &lw,
        &3000u64,
        &2000u64,
        &1000u64,
    );
    assert_eq!(res, Err(Ok(Error::InvalidDeadlines)));

    client.create_trade(
        &id32(&env, 5),
        &p,
        &r,
        &p,
        &10_0000000i128,
        &1i128,
        &idr,
        &crate::types::Flow::TopUp,
        &30u32,
        &120u32,
        &pw,
        &lw,
        &1000u64,
        &2000u64,
        &3000u64,
    );
    let res = client.try_create_trade(
        &id32(&env, 5),
        &p,
        &r,
        &p,
        &10_0000000i128,
        &1i128,
        &idr,
        &crate::types::Flow::TopUp,
        &30u32,
        &120u32,
        &pw,
        &lw,
        &1000u64,
        &2000u64,
        &3000u64,
    );
    assert_eq!(res, Err(Ok(Error::TradeExists)));
}

#[test]
fn test_create_trade_rejects_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);

    let p = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &10_0000000i128);

    client.set_paused(&true);

    let res = client.try_create_trade(
        &id32(&env, 6),
        &p,
        &p,
        &p,
        &10_0000000i128,
        &1i128,
        &Symbol::new(&env, "IDR"),
        &crate::types::Flow::TopUp,
        &30u32,
        &120u32,
        &pw,
        &lw,
        &1000u64,
        &2000u64,
        &3000u64,
    );
    assert_eq!(res, Err(Ok(Error::Paused)));
}

#[test]
fn test_mark_fiat_paid() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    client.mark_fiat_paid(&id32(&env,1));
    assert_eq!(client.get_trade(&id32(&env,1)).status, crate::types::Status::FiatPaid);
}

#[test]
fn test_mark_fiat_paid_rejects_after_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    env.ledger().with_mut(|li| { li.timestamp = 1500; });
    let res = client.try_mark_fiat_paid(&id32(&env,1));
    assert_eq!(res, Err(Ok(Error::DeadlinePassed)));
}

#[test]
fn test_confirm_and_release_splits_fees() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);

    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));

    client.confirm_and_release(&id32(&env,1));

    assert_eq!(usdc.balance(&pw), 3000000i128);
    assert_eq!(usdc.balance(&lw), 1_2000000i128);
    assert_eq!(usdc.balance(&recipient), 98_5000000i128);
    assert_eq!(usdc.balance(&contract_id), 0);
    assert_eq!(client.get_trade(&id32(&env,1)).status, crate::types::Status::Released);
}

#[test]
fn test_refund_after_pay_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    assert_eq!(client.try_refund(&id32(&env,1)), Err(Ok(Error::DeadlineNotReached)));

    env.ledger().with_mut(|li| { li.timestamp = 1500; });
    client.refund(&id32(&env,1));
    assert_eq!(usdc.balance(&p), 100_0000000i128);
    assert_eq!(client.get_trade(&id32(&env,1)).status, crate::types::Status::Refunded);
}

#[test]
fn test_cancel_while_funded() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &50_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &50_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    client.cancel(&id32(&env,1));
    assert_eq!(usdc.balance(&p), 50_0000000i128);
    assert_eq!(client.get_trade(&id32(&env,1)).status, crate::types::Status::Refunded);
}

#[test]
fn test_dispute_then_resolver_releases() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));

    client.raise_dispute(&id32(&env,1), &recipient);
    assert_eq!(client.get_trade(&id32(&env,1)).status, crate::types::Status::Disputed);

    client.resolve(&id32(&env,1), &crate::types::ResolveOutcome::Release, &resolver);
    assert_eq!(usdc.balance(&recipient), 98_5000000i128);
    assert_eq!(usdc.balance(&pw), 3000000i128);
    assert_eq!(usdc.balance(&lw), 1_2000000i128);
    assert_eq!(client.get_trade(&id32(&env,1)).status, crate::types::Status::Released);
}

#[test]
fn test_dispute_then_resolver_refunds() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));
    client.raise_dispute(&id32(&env,1), &provider);
    client.resolve(&id32(&env,1), &crate::types::ResolveOutcome::Refund, &resolver);
    assert_eq!(usdc.balance(&provider), 100_0000000i128);
    assert_eq!(client.get_trade(&id32(&env,1)).status, crate::types::Status::Refunded);
}

#[test]
fn test_only_resolver_can_resolve() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);

    env.mock_all_auths();
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));
    client.raise_dispute(&id32(&env,1), &recipient);

    let stranger = Address::generate(&env);
    let res = client.try_resolve(&id32(&env,1), &crate::types::ResolveOutcome::Release, &stranger);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));

    env.set_auths(&[]);
    let res = client.try_resolve(&id32(&env,1), &crate::types::ResolveOutcome::Release, &resolver);
    assert!(matches!(res, Err(Err(_))));
}

#[test]
fn test_non_party_cannot_dispute() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);

    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env, 1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env, 1));

    let stranger = Address::generate(&env);
    let res = client.try_raise_dispute(&id32(&env, 1), &stranger);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_release_requires_fiat_paid_and_no_double_release() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    assert_eq!(client.try_confirm_and_release(&id32(&env,1)), Err(Ok(Error::InvalidState)));

    client.mark_fiat_paid(&id32(&env,1));
    client.confirm_and_release(&id32(&env,1));
    assert_eq!(client.try_confirm_and_release(&id32(&env,1)), Err(Ok(Error::InvalidState)));
}

#[test]
fn test_dispute_available_after_dispute_deadline_no_freeze() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));

    env.ledger().with_mut(|li| { li.timestamp = 10_000; });

    client.raise_dispute(&id32(&env,1), &recipient);
    assert_eq!(client.get_trade(&id32(&env,1)).status, crate::types::Status::Disputed);

    client.resolve(&id32(&env,1), &crate::types::ResolveOutcome::Release, &resolver);
    assert_eq!(usdc.balance(&recipient), 98_5000000i128);
    assert_eq!(client.get_trade(&id32(&env,1)).status, crate::types::Status::Released);
}

#[test]
fn test_admin_fallback_after_resolver_window() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));
    client.raise_dispute(&id32(&env,1), &recipient);

    let res = client.try_resolve(&id32(&env,1), &crate::types::ResolveOutcome::Refund, &admin);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));

    env.ledger().with_mut(|li| { li.timestamp = 86_401; });

    client.resolve(&id32(&env,1), &crate::types::ResolveOutcome::Refund, &admin);
    assert_eq!(usdc.balance(&provider), 100_0000000i128);
    assert_eq!(client.get_trade(&id32(&env,1)).status, crate::types::Status::Refunded);
}

#[test]
fn test_resolver_can_resolve_before_window() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));
    client.raise_dispute(&id32(&env,1), &recipient);

    client.resolve(&id32(&env,1), &crate::types::ResolveOutcome::Release, &resolver);
    assert_eq!(usdc.balance(&recipient), 98_5000000i128);
    assert_eq!(client.get_trade(&id32(&env,1)).status, crate::types::Status::Released);
}

#[test]
fn test_set_config_token_is_immutable() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);

    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    let (other, _other_admin) = create_usdc(&env, &admin);
    let new_cfg = Config {
        admin: admin.clone(),
        usdc_token: other.address.clone(),
        resolver: resolver.clone(),
        default_platform_fee_bps: 30,
        default_platform_wallet: pw.clone(),
        paused: false,
        dispute_window: 3600,
    };
    assert_eq!(client.try_set_config(&new_cfg), Err(Ok(Error::TokenImmutable)));
    assert_eq!(client.get_config().usdc_token, usdc.address);

    client.mark_fiat_paid(&id32(&env,1));
    client.confirm_and_release(&id32(&env,1));
    assert_eq!(usdc.balance(&pw), 3000000i128);
    assert_eq!(usdc.balance(&lw), 1_2000000i128);
    assert_eq!(usdc.balance(&recipient), 98_5000000i128);
    assert_eq!(usdc.balance(&contract_id), 0);
}

#[test]
fn test_set_config_platform_wallet_immutable_and_fee_capped() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, _usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);

    let evil_pw = Address::generate(&env);
    let cfg_wallet = Config {
        admin: admin.clone(),
        usdc_token: usdc.address.clone(),
        resolver: resolver.clone(),
        default_platform_fee_bps: 30,
        default_platform_wallet: evil_pw,
        paused: false,
        dispute_window: 3600,
    };
    assert_eq!(client.try_set_config(&cfg_wallet), Err(Ok(Error::WalletImmutable)));

    let cfg_fee = Config {
        admin: admin.clone(),
        usdc_token: usdc.address.clone(),
        resolver: resolver.clone(),
        default_platform_fee_bps: 9000,
        default_platform_wallet: pw.clone(),
        paused: false,
        dispute_window: 3600,
    };
    assert_eq!(client.try_set_config(&cfg_fee), Err(Ok(Error::InvalidFee)));

    assert_eq!(client.get_config().default_platform_wallet, pw);
    assert_eq!(client.get_config().default_platform_fee_bps, 30);
}

#[test]
#[should_panic]
fn test_constructor_rejects_absurd_platform_fee() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, _usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 6000u32, pw.clone(), 3600u64));
}

#[test]
fn test_create_trade_rejects_far_future_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &10_0000000i128);
    let idr = Symbol::new(&env, "IDR");

    let pay = 2u64 * 86_400;
    let res = client.try_create_trade(&id32(&env, 7), &p, &r, &p, &10_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw,
        &pay, &(pay + 1), &(pay + 2));
    assert_eq!(res, Err(Ok(Error::InvalidDeadlines)));
}

#[test]
fn test_create_trade_enforces_platform_fee_and_caps_lp_fee() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    let evil = Address::generate(&env);
    usdc_admin.mint(&p, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");

    assert_eq!(
        client.try_create_trade(&id32(&env,1), &p, &r, &p, &10_0000000i128, &1i128, &idr,
            &crate::types::Flow::TopUp, &0u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64),
        Err(Ok(Error::InvalidFee)));
    assert_eq!(
        client.try_create_trade(&id32(&env,2), &p, &r, &p, &10_0000000i128, &1i128, &idr,
            &crate::types::Flow::TopUp, &30u32, &120u32, &evil, &lw, &1000u64, &2000u64, &3000u64),
        Err(Ok(Error::InvalidFee)));
    assert_eq!(
        client.try_create_trade(&id32(&env,3), &p, &r, &p, &10_0000000i128, &1i128, &idr,
            &crate::types::Flow::TopUp, &30u32, &600u32, &pw, &lw, &1000u64, &2000u64, &3000u64),
        Err(Ok(Error::InvalidFee)));
    client.create_trade(&id32(&env,4), &p, &r, &p, &10_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    assert_eq!(client.get_trade(&id32(&env,4)).status, crate::types::Status::Funded);
}

#[test]
fn test_create_trade_rejects_bad_roles() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &10_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    assert_eq!(
        client.try_create_trade(&id32(&env,1), &p, &r, &r, &10_0000000i128, &1i128, &idr,
            &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64),
        Err(Ok(Error::InvalidRoles)));
    assert_eq!(
        client.try_create_trade(&id32(&env,2), &p, &p, &p, &10_0000000i128, &1i128, &idr,
            &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64),
        Err(Ok(Error::InvalidRoles)));
}

#[test]
fn test_create_trade_rejects_too_short_pay_window() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &10_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    assert_eq!(
        client.try_create_trade(&id32(&env,3), &p, &r, &p, &10_0000000i128, &1i128, &idr,
            &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &60u64, &700u64, &800u64),
        Err(Ok(Error::InvalidDeadlines)));
}

#[test]
fn test_fee_split_exact_on_non_round_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &333i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &333i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));
    client.confirm_and_release(&id32(&env,1));
    assert_eq!(usdc.balance(&pw), 0);
    assert_eq!(usdc.balance(&lw), 3);
    assert_eq!(usdc.balance(&r), 330);
    assert_eq!(usdc.balance(&contract_id), 0);
}

#[test]
fn test_resolve_works_while_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
        let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));
    client.raise_dispute(&id32(&env,1), &recipient);

    client.set_paused(&true);
    assert!(client.get_config().paused);

    client.resolve(&id32(&env,1), &crate::types::ResolveOutcome::Release, &resolver);
    assert_eq!(usdc.balance(&recipient), 98_5000000i128);
    assert_eq!(client.get_trade(&id32(&env,1)).status, crate::types::Status::Released);
}

#[test]
fn test_create_trade_defaults_settled_at_and_pre_dispute_status() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &10_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &10_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    let t = client.get_trade(&id32(&env,1));
    assert_eq!(t.settled_at, 0);
    assert!(!t.has_pre_dispute_status);
    assert_eq!(t.pre_dispute_status(), None);
}

#[test]
fn test_confirm_and_release_sets_settled_at() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &10_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &10_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));

    env.ledger().with_mut(|li| { li.timestamp = 500; });
    client.confirm_and_release(&id32(&env,1));

    let t = client.get_trade(&id32(&env,1));
    assert_eq!(t.status, crate::types::Status::Released);
    assert_eq!(t.settled_at, 500);
}

#[test]
fn test_refund_sets_settled_at() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    env.ledger().with_mut(|li| { li.timestamp = 1500; });
    client.refund(&id32(&env,1));

    let t = client.get_trade(&id32(&env,1));
    assert_eq!(t.status, crate::types::Status::Refunded);
    assert_eq!(t.settled_at, 1500);
}

#[test]
fn test_cancel_sets_settled_at() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &50_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &50_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    env.ledger().with_mut(|li| { li.timestamp = 42; });
    client.cancel(&id32(&env,1));

    assert_eq!(client.get_trade(&id32(&env,1)).settled_at, 42);
}

#[test]
fn test_resolve_release_sets_settled_at() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));
    client.raise_dispute(&id32(&env,1), &recipient);

    env.ledger().with_mut(|li| { li.timestamp = 777; });
    client.resolve(&id32(&env,1), &crate::types::ResolveOutcome::Release, &resolver);

    let t = client.get_trade(&id32(&env,1));
    assert_eq!(t.status, crate::types::Status::Released);
    assert_eq!(t.settled_at, 777);
}

#[test]
fn test_resolve_refund_sets_settled_at() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));
    client.raise_dispute(&id32(&env,1), &provider);

    env.ledger().with_mut(|li| { li.timestamp = 888; });
    client.resolve(&id32(&env,1), &crate::types::ResolveOutcome::Refund, &resolver);

    let t = client.get_trade(&id32(&env,1));
    assert_eq!(t.status, crate::types::Status::Refunded);
    assert_eq!(t.settled_at, 888);
}

#[test]
#[should_panic]
fn test_constructor_rejects_zero_dispute_window() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, _usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 0u64));
}

#[test]
#[should_panic]
fn test_constructor_rejects_dispute_window_too_large() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, _usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 604_801u64));
}

#[test]
fn test_set_config_validates_dispute_window_bounds() {
    let (_env, client, admin, usdc, resolver, pw) = setup();

    let zero_window = Config {
        admin: admin.clone(),
        usdc_token: usdc.clone(),
        resolver: resolver.clone(),
        default_platform_fee_bps: 30,
        default_platform_wallet: pw.clone(),
        paused: false,
        dispute_window: 0,
    };
    assert_eq!(client.try_set_config(&zero_window), Err(Ok(Error::InvalidConfig)));

    let too_large_window = Config {
        admin: admin.clone(),
        usdc_token: usdc.clone(),
        resolver: resolver.clone(),
        default_platform_fee_bps: 30,
        default_platform_wallet: pw.clone(),
        paused: false,
        dispute_window: 604_801,
    };
    assert_eq!(client.try_set_config(&too_large_window), Err(Ok(Error::InvalidConfig)));

    assert_eq!(client.get_config().dispute_window, 3600);

    let valid_window = Config {
        admin: admin.clone(),
        usdc_token: usdc.clone(),
        resolver: resolver.clone(),
        default_platform_fee_bps: 30,
        default_platform_wallet: pw.clone(),
        paused: false,
        dispute_window: 604_800,
    };
    client.set_config(&valid_window);
    assert_eq!(client.get_config().dispute_window, 604_800);
}

#[test]
fn test_raise_dispute_post_settle_from_released_within_window() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));

    env.ledger().with_mut(|li| { li.timestamp = 500; });
    client.confirm_and_release(&id32(&env,1));

    let pw_bal = usdc.balance(&pw);
    let lw_bal = usdc.balance(&lw);
    let recipient_bal = usdc.balance(&recipient);

    env.ledger().with_mut(|li| { li.timestamp = 4000; });
    client.raise_dispute(&id32(&env,1), &recipient);

    let t = client.get_trade(&id32(&env,1));
    assert_eq!(t.status, crate::types::Status::Disputed);
    assert_eq!(t.pre_dispute_status(), Some(crate::types::Status::Released));
    assert_eq!(t.settled_at, 500);

    let (is_disputed, view_provider, view_recipient, view_amount) = client.dispute_view(&id32(&env,1));
    assert!(is_disputed);
    assert_eq!(view_provider, provider);
    assert_eq!(view_recipient, recipient);
    assert_eq!(view_amount, 100_0000000i128);

    assert_eq!(usdc.balance(&pw), pw_bal);
    assert_eq!(usdc.balance(&lw), lw_bal);
    assert_eq!(usdc.balance(&recipient), recipient_bal);
}

#[test]
fn test_raise_dispute_post_settle_from_refunded_within_window() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    env.ledger().with_mut(|li| { li.timestamp = 1500; });
    client.refund(&id32(&env,1));
    let provider_bal = usdc.balance(&provider);

    env.ledger().with_mut(|li| { li.timestamp = 3300; });
    client.raise_dispute(&id32(&env,1), &provider);

    let t = client.get_trade(&id32(&env,1));
    assert_eq!(t.status, crate::types::Status::Disputed);
    assert_eq!(t.pre_dispute_status(), Some(crate::types::Status::Refunded));
    assert_eq!(usdc.balance(&provider), provider_bal);
}

#[test]
fn test_raise_dispute_post_settle_rejected_past_window() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));

    env.ledger().with_mut(|li| { li.timestamp = 500; });
    client.confirm_and_release(&id32(&env,1));

    env.ledger().with_mut(|li| { li.timestamp = 4101; });
    let res = client.try_raise_dispute(&id32(&env,1), &recipient);
    assert_eq!(res, Err(Ok(Error::DisputeWindowPassed)));
    assert_eq!(client.get_trade(&id32(&env,1)).status, crate::types::Status::Released);
}

#[test]
fn test_raise_dispute_post_settle_boundary_is_inclusive() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));

    env.ledger().with_mut(|li| { li.timestamp = 500; });
    client.confirm_and_release(&id32(&env,1));

    env.ledger().with_mut(|li| { li.timestamp = 4100; });
    client.raise_dispute(&id32(&env,1), &recipient);
    assert_eq!(client.get_trade(&id32(&env,1)).status, crate::types::Status::Disputed);
}

#[test]
fn test_raise_dispute_post_settle_guards_zero_settled_at() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));
    client.confirm_and_release(&id32(&env,1));
    assert_eq!(client.get_trade(&id32(&env,1)).settled_at, 0);

    let res = client.try_raise_dispute(&id32(&env,1), &recipient);
    assert_eq!(res, Err(Ok(Error::InvalidState)));
}

#[test]
fn test_resolve_post_settle_release_origin_is_verdict_only() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));

    env.ledger().with_mut(|li| { li.timestamp = 500; });
    client.confirm_and_release(&id32(&env,1));

    env.ledger().with_mut(|li| { li.timestamp = 4000; });
    client.raise_dispute(&id32(&env,1), &recipient);

    let pw_bal = usdc.balance(&pw);
    let lw_bal = usdc.balance(&lw);
    let recipient_bal = usdc.balance(&recipient);
    let provider_bal = usdc.balance(&provider);
    let contract_bal = usdc.balance(&contract_id);
    assert_eq!(contract_bal, 0);

    client.resolve(&id32(&env,1), &crate::types::ResolveOutcome::Release, &resolver);

    let expected = crate::events::Resolved {
        trade_id: id32(&env, 1),
        released: true,
        post_settle: true,
    };
    let raw = env.events().all().filter_by_contract(&contract_id);
    let raw = raw.events();
    assert_eq!(raw.len(), 1);
    assert_eq!(raw[0], expected.to_xdr(&env, &contract_id));

    assert_eq!(usdc.balance(&pw), pw_bal);
    assert_eq!(usdc.balance(&lw), lw_bal);
    assert_eq!(usdc.balance(&recipient), recipient_bal);
    assert_eq!(usdc.balance(&provider), provider_bal);
    assert_eq!(usdc.balance(&contract_id), contract_bal);

    let t = client.get_trade(&id32(&env,1));
    assert_eq!(t.status, crate::types::Status::Released);
    assert_eq!(t.pre_dispute_status(), None);
    assert!(t.post_settle_resolved);
    assert_eq!(t.settled_at, 500);
}

#[test]
fn test_resolve_post_settle_refunded_origin_restores_refunded() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    env.ledger().with_mut(|li| { li.timestamp = 1500; });
    client.refund(&id32(&env,1));

    env.ledger().with_mut(|li| { li.timestamp = 3000; });
    client.raise_dispute(&id32(&env,1), &provider);
    let provider_bal = usdc.balance(&provider);

    client.resolve(&id32(&env,1), &crate::types::ResolveOutcome::Refund, &resolver);

    assert_eq!(usdc.balance(&provider), provider_bal);
    let t = client.get_trade(&id32(&env,1));
    assert_eq!(t.status, crate::types::Status::Refunded);
    assert_eq!(t.pre_dispute_status(), None);
    assert!(t.post_settle_resolved);
    let (is_disputed, ..) = client.dispute_view(&id32(&env,1));
    assert!(!is_disputed);
}

#[test]
fn test_raise_dispute_post_settle_latched_after_resolve() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));

    env.ledger().with_mut(|li| { li.timestamp = 500; });
    client.confirm_and_release(&id32(&env,1));

    env.ledger().with_mut(|li| { li.timestamp = 1000; });
    client.raise_dispute(&id32(&env,1), &recipient);
    client.resolve(&id32(&env,1), &crate::types::ResolveOutcome::Release, &resolver);

    env.ledger().with_mut(|li| { li.timestamp = 2000; });
    let res = client.try_raise_dispute(&id32(&env,1), &recipient);
    assert_eq!(res, Err(Ok(Error::AlreadyResolved)));
    assert_eq!(client.get_trade(&id32(&env,1)).status, crate::types::Status::Released);
}

#[test]
fn test_post_settle_resolved_trade_blocks_confirm_and_refund() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);

    let provider_a = Address::generate(&env);
    let recipient_a = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider_a, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider_a, &recipient_a, &provider_a, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));
    env.ledger().with_mut(|li| { li.timestamp = 500; });
    client.confirm_and_release(&id32(&env,1));
    env.ledger().with_mut(|li| { li.timestamp = 1000; });
    client.raise_dispute(&id32(&env,1), &recipient_a);
    client.resolve(&id32(&env,1), &crate::types::ResolveOutcome::Release, &resolver);
    assert_eq!(
        client.try_confirm_and_release(&id32(&env,1)),
        Err(Ok(Error::InvalidState))
    );

    env.ledger().with_mut(|li| { li.timestamp = 0; });
    let provider_b = Address::generate(&env);
    let recipient_b = Address::generate(&env);
    usdc_admin.mint(&provider_b, &100_0000000i128);
    client.create_trade(&id32(&env,2), &provider_b, &recipient_b, &provider_b, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    env.ledger().with_mut(|li| { li.timestamp = 1500; });
    client.refund(&id32(&env,2));
    env.ledger().with_mut(|li| { li.timestamp = 2000; });
    client.raise_dispute(&id32(&env,2), &provider_b);
    client.resolve(&id32(&env,2), &crate::types::ResolveOutcome::Refund, &resolver);
    assert_eq!(
        client.try_refund(&id32(&env,2)),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn test_resolve_post_settle_admin_fallback_after_resolver_window() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));

    env.ledger().with_mut(|li| { li.timestamp = 500; });
    client.confirm_and_release(&id32(&env,1));

    env.ledger().with_mut(|li| { li.timestamp = 1000; });
    client.raise_dispute(&id32(&env,1), &recipient);

    let res = client.try_resolve(&id32(&env,1), &crate::types::ResolveOutcome::Release, &admin);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));

    env.ledger().with_mut(|li| { li.timestamp = 87_401; });
    client.resolve(&id32(&env,1), &crate::types::ResolveOutcome::Release, &admin);

    let t = client.get_trade(&id32(&env,1));
    assert_eq!(t.status, crate::types::Status::Released);
    assert!(t.post_settle_resolved);
}

#[test]
fn test_resolve_normal_dispute_event_has_post_settle_false() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1));
    client.raise_dispute(&id32(&env,1), &recipient);

    client.resolve(&id32(&env,1), &crate::types::ResolveOutcome::Release, &resolver);

    let expected = crate::events::Resolved {
        trade_id: id32(&env, 1),
        released: true,
        post_settle: false,
    };
    let raw = env.events().all().filter_by_contract(&contract_id);
    let raw = raw.events();
    assert_eq!(raw.len(), 1);
    assert_eq!(raw[0], expected.to_xdr(&env, &contract_id));
}
