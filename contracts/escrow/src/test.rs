#![cfg(test)]
use soroban_sdk::{testutils::{Address as _, Events as _, Ledger, MockAuth, MockAuthInvoke}, token, Address, BytesN, Env, Event, IntoVal, Symbol};

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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.clone(), resolver.clone(), 30u32, platform_wallet.clone(), 3600u64, Address::generate(&env)));
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
        early_release_providers: client.get_config().early_release_providers,
        fiat_attestor: client.get_config().fiat_attestor,
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
        early_release_providers: client.get_config().early_release_providers,
        fiat_attestor: client.get_config().fiat_attestor,
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
        early_release_providers: client.get_config().early_release_providers,
        fiat_attestor: client.get_config().fiat_attestor,
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
        early_release_providers: client.get_config().early_release_providers,
        fiat_attestor: client.get_config().fiat_attestor,
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, platform_wallet.clone(), 3600u64, Address::generate(&env)));
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
        let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    client.mark_fiat_paid(&id32(&env,1), &r);
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
        let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    env.ledger().with_mut(|li| { li.timestamp = 1500; });
    let res = client.try_mark_fiat_paid(&id32(&env,1), &r);
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
        let client = EscrowContractClient::new(&env, &contract_id);

    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);

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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
        let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    assert_eq!(client.try_refund(&id32(&env,1)), Err(Ok(Error::DeadlineNotReached)));

    env.ledger().with_mut(|li| { li.timestamp = 5000; });
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
        let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);

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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
        let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
        let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
        let client = EscrowContractClient::new(&env, &contract_id);

    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env, 1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env, 1), &recipient);

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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
        let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    assert_eq!(client.try_confirm_and_release(&id32(&env,1)), Err(Ok(Error::InvalidState)));

    client.mark_fiat_paid(&id32(&env,1), &r);
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
        let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);

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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
        let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
        let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
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
        early_release_providers: client.get_config().early_release_providers,
        fiat_attestor: client.get_config().fiat_attestor,
        dispute_window: 3600,
    };
    assert_eq!(client.try_set_config(&new_cfg), Err(Ok(Error::TokenImmutable)));
    assert_eq!(client.get_config().usdc_token, usdc.address);

    client.mark_fiat_paid(&id32(&env,1), &recipient);
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
        let client = EscrowContractClient::new(&env, &contract_id);

    let evil_pw = Address::generate(&env);
    let cfg_wallet = Config {
        admin: admin.clone(),
        usdc_token: usdc.address.clone(),
        resolver: resolver.clone(),
        default_platform_fee_bps: 30,
        default_platform_wallet: evil_pw,
        paused: false,
        early_release_providers: client.get_config().early_release_providers,
        fiat_attestor: client.get_config().fiat_attestor,
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
        early_release_providers: client.get_config().early_release_providers,
        fiat_attestor: client.get_config().fiat_attestor,
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
    env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 6000u32, pw.clone(), 3600u64, Address::generate(&env)));
}

#[test]
fn test_create_trade_rejects_far_future_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &333i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &333i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &r);
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
        let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &10_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &10_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &r);

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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    let p = Address::generate(&env);
    let r = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&p, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &p, &r, &p, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    env.ledger().with_mut(|li| { li.timestamp = 5000; });
    client.refund(&id32(&env,1));

    let t = client.get_trade(&id32(&env,1));
    assert_eq!(t.status, crate::types::Status::Refunded);
    assert_eq!(t.settled_at, 5000);
}

#[test]
fn test_cancel_sets_settled_at() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);
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
    env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 0u64, Address::generate(&env)));
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
    env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 604_801u64, Address::generate(&env)));
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
        early_release_providers: client.get_config().early_release_providers,
        fiat_attestor: client.get_config().fiat_attestor,
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
        early_release_providers: client.get_config().early_release_providers,
        fiat_attestor: client.get_config().fiat_attestor,
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
        early_release_providers: client.get_config().early_release_providers,
        fiat_attestor: client.get_config().fiat_attestor,
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);

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

    let (is_disputed, view_provider, view_recipient, view_amount, _pre, _rel, _dl) = client.dispute_view(&id32(&env,1));
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    env.ledger().with_mut(|li| { li.timestamp = 5000; });
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);

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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);

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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);

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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);

    env.ledger().with_mut(|li| { li.timestamp = 5000; });
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);

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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);

    let provider_a = Address::generate(&env);
    let recipient_a = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider_a, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider_a, &recipient_a, &provider_a, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient_a);
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
    env.ledger().with_mut(|li| { li.timestamp = 5000; });
    client.refund(&id32(&env,2));
    env.ledger().with_mut(|li| { li.timestamp = 5000; });
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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);

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
    let contract_id = env.register(EscrowContract, (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    let idr = Symbol::new(&env, "IDR");
    client.create_trade(&id32(&env,1), &provider, &recipient, &provider, &100_0000000i128, &1i128, &idr,
        &crate::types::Flow::TopUp, &30u32, &120u32, &pw, &lw, &1000u64, &2000u64, &3000u64);
    client.mark_fiat_paid(&id32(&env,1), &recipient);
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

fn attested_setup() -> (
    Env,
    EscrowContractClient<'static>,
    Address,
    Address,
    Address,
    Address,
    token::TokenClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let attestor = Address::generate(&env);
    let contract_id = env.register(
        EscrowContract,
        (
            admin.clone(),
            usdc.address.clone(),
            resolver.clone(),
            30u32,
            pw.clone(),
            3600u64,
            attestor.clone(),
        ),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    client.create_trade(
        &id32(&env, 1),
        &provider,
        &recipient,
        &provider,
        &100_0000000i128,
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
    (env, client, attestor, provider, recipient, resolver, usdc)
}

fn balances(usdc: &token::TokenClient<'static>, a: &Address, b: &Address) -> (i128, i128) {
    (usdc.balance(a), usdc.balance(b))
}

#[test]
fn attestor_may_mark_fiat_paid_and_moves_no_money() {
    let (env, client, attestor, provider, recipient, _resolver, usdc) = attested_setup();
    let before = balances(&usdc, &provider, &recipient);

    client.mark_fiat_paid(&id32(&env, 1), &attestor);

    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::FiatPaid);
    assert_eq!(balances(&usdc, &provider, &recipient), before);
}

#[test]
fn attestor_may_mark_paid_between_pay_and_confirm_deadline() {
    let (env, client, attestor, _p, _r, _res, _usdc) = attested_setup();
    env.ledger().with_mut(|l| l.timestamp = 1500);

    client.mark_fiat_paid(&id32(&env, 1), &attestor);

    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::FiatPaid);
}

#[test]
fn attestor_is_bounded_by_the_confirm_deadline() {
    let (env, client, attestor, _p, _r, _res, _usdc) = attested_setup();
    env.ledger().with_mut(|l| l.timestamp = 2500);

    let res = client.try_mark_fiat_paid(&id32(&env, 1), &attestor);

    assert_eq!(res, Err(Ok(Error::DeadlinePassed)));
}

#[test]
fn recipient_is_still_bounded_by_the_pay_deadline() {
    let (env, client, _attestor, _p, recipient, _res, _usdc) = attested_setup();
    env.ledger().with_mut(|l| l.timestamp = 1500);

    let res = client.try_mark_fiat_paid(&id32(&env, 1), &recipient);

    assert_eq!(res, Err(Ok(Error::DeadlinePassed)));
}

#[test]
fn a_random_address_may_not_mark_fiat_paid() {
    let (env, client, _attestor, _p, _r, _res, _usdc) = attested_setup();
    let stranger = Address::generate(&env);

    let res = client.try_mark_fiat_paid(&id32(&env, 1), &stranger);

    assert_eq!(res, Err(Ok(Error::Unauthorized)));
}

#[test]
fn the_attestor_cannot_resolve_or_dispute() {
    let (env, client, attestor, _p, _r, _res, _usdc) = attested_setup();

    client.mark_fiat_paid(&id32(&env, 1), &attestor);

    let disputed = client.try_raise_dispute(&id32(&env, 1), &attestor);
    assert_eq!(disputed, Err(Ok(Error::Unauthorized)));

    client.raise_dispute(&id32(&env, 1), &_p);
    let resolved = client.try_resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Release, &attestor);
    assert_eq!(resolved, Err(Ok(Error::Unauthorized)));
}

#[test]
fn the_attestor_cannot_release_without_the_party_signature() {
    let (env, client, attestor, provider, recipient, _res, usdc) = attested_setup();
    client.mark_fiat_paid(&id32(&env, 1), &attestor);
    let before = balances(&usdc, &provider, &recipient);

    env.set_auths(&[]);
    let released = client.try_confirm_and_release(&id32(&env, 1));

    assert!(released.is_err());
    assert_eq!(balances(&usdc, &provider, &recipient), before);
}

#[test]
fn marking_fiat_paid_blocks_the_refund() {
    let (env, client, attestor, _p, _r, _res, _usdc) = attested_setup();
    client.mark_fiat_paid(&id32(&env, 1), &attestor);
    env.ledger().with_mut(|l| l.timestamp = 1500);

    let res = client.try_refund(&id32(&env, 1));

    assert_eq!(res, Err(Ok(Error::InvalidState)));
}

#[test]
fn naming_the_attestor_is_not_the_same_as_being_the_attestor() {
    let (env, client, attestor, _p, _r, _res, _usdc) = attested_setup();

    env.set_auths(&[]);
    let res = client.try_mark_fiat_paid(&id32(&env, 1), &attestor);

    assert!(res.is_err());
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Funded);
}

#[test]
fn naming_the_recipient_is_not_the_same_as_being_the_recipient() {
    let (env, client, _attestor, _p, recipient, _res, _usdc) = attested_setup();

    env.set_auths(&[]);
    let res = client.try_mark_fiat_paid(&id32(&env, 1), &recipient);

    assert!(res.is_err());
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Funded);
}

fn withdraw_setup() -> (Env, EscrowContractClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let attestor = Address::generate(&env);
    let contract_id = env.register(
        EscrowContract,
        (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, attestor.clone()),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    client.create_trade(
        &id32(&env, 1), &provider, &recipient, &provider, &100_0000000i128, &1i128,
        &Symbol::new(&env, "IDR"), &crate::types::Flow::Withdraw, &30u32, &120u32,
        &pw, &lw, &1000u64, &2000u64, &3000u64,
    );
    (env, client, attestor, provider, recipient)
}

#[test]
fn attestation_is_refused_from_every_status_but_funded() {
    let (env, client, attestor, _p, recipient, _res, _usdc) = attested_setup();
    client.mark_fiat_paid(&id32(&env, 1), &attestor);

    for caller in [&attestor, &recipient] {
        let res = client.try_mark_fiat_paid(&id32(&env, 1), caller);
        assert_eq!(res, Err(Ok(Error::InvalidState)));
    }
}

#[test]
fn attestation_is_refused_on_a_refunded_trade_so_the_pool_cannot_be_drained() {
    let (env, client, attestor, _p, _r, _res, _usdc) = attested_setup();
    env.ledger().with_mut(|l| l.timestamp = 5000);
    client.refund(&id32(&env, 1));

    let res = client.try_mark_fiat_paid(&id32(&env, 1), &attestor);

    assert_eq!(res, Err(Ok(Error::InvalidState)));
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Refunded);
}

#[test]
fn neither_the_provider_nor_the_admin_may_attest() {
    let (env, client, _attestor, provider, _r, _res, _usdc) = attested_setup();
    let admin = client.get_config().admin;

    assert_eq!(client.try_mark_fiat_paid(&id32(&env, 1), &provider), Err(Ok(Error::Unauthorized)));
    assert_eq!(client.try_mark_fiat_paid(&id32(&env, 1), &admin), Err(Ok(Error::Unauthorized)));
}

#[test]
fn the_deadline_is_inclusive_to_the_exact_second_for_both_callers() {
    let (env, client, _attestor, _p, recipient, _res, _usdc) = attested_setup();
    env.ledger().with_mut(|l| l.timestamp = 1000);
    client.mark_fiat_paid(&id32(&env, 1), &recipient);

    let (env2, client2, attestor2, _p2, _r2, _res2, _u2) = attested_setup();
    env2.ledger().with_mut(|l| l.timestamp = 1001);
    assert_eq!(
        client2.try_mark_fiat_paid(&id32(&env2, 1), &_r2),
        Err(Ok(Error::DeadlinePassed))
    );
    client2.mark_fiat_paid(&id32(&env2, 1), &attestor2);
}

#[test]
fn pausing_never_stops_the_party_from_moving_their_own_trade() {
    let (env, client, _attestor, _p, recipient, _res, _usdc) = attested_setup();
    client.set_paused(&true);

    client.mark_fiat_paid(&id32(&env, 1), &recipient);

    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::FiatPaid);
}

#[test]
fn pausing_stops_the_attestor() {
    let (env, client, attestor, _p, _r, _res, _usdc) = attested_setup();
    client.set_paused(&true);

    assert_eq!(client.try_mark_fiat_paid(&id32(&env, 1), &attestor), Err(Ok(Error::Paused)));

    client.set_paused(&false);
    client.mark_fiat_paid(&id32(&env, 1), &attestor);
}

#[test]
fn the_attestor_has_no_authority_over_a_withdrawal() {
    let (env, client, attestor, _p, recipient) = withdraw_setup();

    assert_eq!(client.try_mark_fiat_paid(&id32(&env, 1), &attestor), Err(Ok(Error::Unauthorized)));

    client.mark_fiat_paid(&id32(&env, 1), &recipient);
}

fn long_window_setup() -> (Env, EscrowContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let attestor = Address::generate(&env);
    let contract_id = env.register(
        EscrowContract,
        (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, attestor.clone()),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    client.create_trade(
        &id32(&env, 1), &provider, &recipient, &provider, &100_0000000i128, &1i128,
        &Symbol::new(&env, "IDR"), &crate::types::Flow::TopUp, &30u32, &120u32,
        &pw, &lw, &1000u64, &1_000_000u64, &2_000_000u64,
    );
    (env, client, attestor)
}

#[test]
fn the_attestor_window_is_bounded_by_a_grace_not_by_a_month_long_confirm_deadline() {
    let (env, client, attestor) = long_window_setup();
    env.ledger().with_mut(|l| l.timestamp = 1000 + crate::ATTEST_GRACE_SECS);
    client.mark_fiat_paid(&id32(&env, 1), &attestor);

    let (env2, client2, attestor2) = long_window_setup();
    env2.ledger().with_mut(|l| l.timestamp = 1001 + crate::ATTEST_GRACE_SECS);
    assert_eq!(
        client2.try_mark_fiat_paid(&id32(&env2, 1), &attestor2),
        Err(Ok(Error::DeadlinePassed))
    );
}

#[test]
fn the_attestor_window_never_outlasts_the_confirm_deadline_either() {
    let (env, client, attestor, _p, _r, _res, _usdc) = attested_setup();
    env.ledger().with_mut(|l| l.timestamp = 2001);

    assert_eq!(
        client.try_mark_fiat_paid(&id32(&env, 1), &attestor),
        Err(Ok(Error::DeadlinePassed))
    );
}

#[test]
fn a_refund_may_not_front_run_the_attestor_on_a_deposit() {
    let (env, client, attestor, provider, _r, _res, usdc) = attested_setup();
    env.ledger().with_mut(|l| l.timestamp = 1001);

    assert_eq!(client.try_refund(&id32(&env, 1)), Err(Ok(Error::DeadlineNotReached)));
    assert_eq!(usdc.balance(&provider), 0);

    client.mark_fiat_paid(&id32(&env, 1), &attestor);
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::FiatPaid);
}

#[test]
fn a_withdrawal_refund_waits_for_the_confirm_deadline() {
    let (env, client, _attestor, provider, _r) = withdraw_setup();
    env.ledger().with_mut(|l| l.timestamp = 2000);

    assert_eq!(
        client.try_refund(&id32(&env, 1)),
        Err(Ok(Error::DeadlineNotReached))
    );

    env.ledger().with_mut(|l| l.timestamp = 2001);
    client.refund(&id32(&env, 1));
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Refunded);
    let _ = provider;
}

#[test]
fn the_attestor_may_not_be_rotated_by_configuration() {
    let (env, client, attestor, _p, _r, _res, _usdc) = attested_setup();
    let mut cfg = client.get_config();
    cfg.fiat_attestor = Address::generate(&env);

    let res = client.try_set_config(&cfg);

    assert_eq!(res, Err(Ok(Error::InvalidConfig)));
    assert_eq!(client.get_config().fiat_attestor, attestor);
}

fn early_setup(
    flow: crate::types::Flow,
    allowlist: bool,
) -> (Env, EscrowContractClient<'static>, Address, Address, Address, Address, token::TokenClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let attestor = Address::generate(&env);
    let contract_id = env.register(
        EscrowContract,
        (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, attestor.clone()),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);

    if allowlist {
        let mut cfg = client.get_config();
        cfg.early_release_providers = soroban_sdk::vec![&env, provider.clone()];
        client.set_config(&cfg);
    }

    client.create_trade(
        &id32(&env, 1), &provider, &recipient, &provider, &100_0000000i128, &1i128,
        &Symbol::new(&env, "IDR"), &flow, &30u32, &120u32,
        &pw, &lw, &1000u64, &2000u64, &3000u64,
    );
    (env, client, provider, recipient, pw, lw, usdc)
}

#[test]
fn release_from_funded_succeeds_for_top_up() {
    let (env, client, _p, recipient, pw, lw, usdc) = early_setup(crate::types::Flow::TopUp, true);
    env.ledger().with_mut(|l| l.timestamp = 500);

    client.release_from_funded(&id32(&env, 1));

    let trade = client.get_trade(&id32(&env, 1));
    assert_eq!(trade.status, crate::types::Status::Released);
    assert_eq!(trade.settled_at, 500);
    assert_eq!(usdc.balance(&client.address), 0);
    assert_eq!(usdc.balance(&pw), 3_000_000i128);
    assert_eq!(usdc.balance(&lw), 12_000_000i128);
    assert_eq!(usdc.balance(&recipient), 100_0000000i128 - 3_000_000i128 - 12_000_000i128);
}

#[test]
fn release_from_funded_rejects_the_withdraw_flow_and_the_exit_survives() {
    let (env, client, provider, recipient, _pw, _lw, usdc) =
        early_setup(crate::types::Flow::Withdraw, true);
    let before = (usdc.balance(&provider), usdc.balance(&recipient));

    let res = client.try_release_from_funded(&id32(&env, 1));

    assert_eq!(res, Err(Ok(Error::EarlyReleaseNotAllowed)));
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Funded);
    assert_eq!((usdc.balance(&provider), usdc.balance(&recipient)), before);

    env.ledger().with_mut(|l| l.timestamp = 2001);
    client.refund(&id32(&env, 1));
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Refunded);
}

#[test]
fn release_from_funded_rejects_a_provider_not_on_the_list() {
    let (env, client, provider, recipient, _pw, _lw, usdc) =
        early_setup(crate::types::Flow::TopUp, false);
    let before = (usdc.balance(&provider), usdc.balance(&recipient));

    let res = client.try_release_from_funded(&id32(&env, 1));

    assert_eq!(res, Err(Ok(Error::EarlyReleaseNotAllowed)));
    assert_eq!((usdc.balance(&provider), usdc.balance(&recipient)), before);
}

#[test]
fn removing_a_provider_disables_early_release_but_not_the_ordinary_path() {
    let (env, client, _p, recipient, _pw, _lw, _usdc) = early_setup(crate::types::Flow::TopUp, true);
    let mut cfg = client.get_config();
    cfg.early_release_providers = soroban_sdk::vec![&env];
    client.set_config(&cfg);

    assert_eq!(
        client.try_release_from_funded(&id32(&env, 1)),
        Err(Ok(Error::EarlyReleaseNotAllowed))
    );

    client.mark_fiat_paid(&id32(&env, 1), &recipient);
    client.confirm_and_release(&id32(&env, 1));
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Released);
}

#[test]
fn release_from_funded_requires_the_confirmer_signature() {
    let (env, client, provider, recipient, _pw, _lw, usdc) =
        early_setup(crate::types::Flow::TopUp, true);
    let before = (usdc.balance(&provider), usdc.balance(&recipient));

    env.set_auths(&[]);
    let res = client.try_release_from_funded(&id32(&env, 1));

    assert!(res.is_err());
    assert_eq!((usdc.balance(&provider), usdc.balance(&recipient)), before);
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Funded);
}

#[test]
fn release_from_funded_rejects_after_the_confirm_deadline() {
    let (env, client, _p, _r, _pw, _lw, _usdc) = early_setup(crate::types::Flow::TopUp, true);
    env.ledger().with_mut(|l| l.timestamp = 2001);

    assert_eq!(
        client.try_release_from_funded(&id32(&env, 1)),
        Err(Ok(Error::DeadlinePassed))
    );

    env.ledger().with_mut(|l| l.timestamp = 5000);
    client.refund(&id32(&env, 1));
}

#[test]
fn release_from_funded_is_refused_while_paused() {
    let (env, client, _p, _r, _pw, _lw, _usdc) = early_setup(crate::types::Flow::TopUp, true);
    client.set_paused(&true);

    assert_eq!(client.try_release_from_funded(&id32(&env, 1)), Err(Ok(Error::Paused)));

    client.set_paused(&false);
    client.release_from_funded(&id32(&env, 1));
}

#[test]
fn pausing_never_traps_funds() {
    let (env, client, _p, recipient, _pw, _lw, _usdc) = early_setup(crate::types::Flow::TopUp, true);
    client.set_paused(&true);

    client.mark_fiat_paid(&id32(&env, 1), &recipient);
    client.confirm_and_release(&id32(&env, 1));

    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Released);
}

#[test]
fn pausing_never_traps_a_refund_either() {
    let (env, client, _p, _r, _pw, _lw, _usdc) = early_setup(crate::types::Flow::TopUp, true);
    client.set_paused(&true);
    env.ledger().with_mut(|l| l.timestamp = 5000);

    client.refund(&id32(&env, 1));

    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Refunded);
}

#[test]
fn release_from_funded_is_single_shot() {
    let (env, client, _p, recipient, _pw, _lw, usdc) = early_setup(crate::types::Flow::TopUp, true);
    client.release_from_funded(&id32(&env, 1));
    let after_first = usdc.balance(&recipient);

    let res = client.try_release_from_funded(&id32(&env, 1));

    assert_eq!(res, Err(Ok(Error::InvalidState)));
    assert_eq!(usdc.balance(&recipient), after_first);
}

#[test]
fn confirm_and_release_still_rejects_funded() {
    let (env, client, _p, _r, _pw, _lw, _usdc) = early_setup(crate::types::Flow::TopUp, true);

    assert_eq!(
        client.try_confirm_and_release(&id32(&env, 1)),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn release_from_funded_then_refund_is_rejected_and_the_reverse_too() {
    let (env, client, _p, _r, _pw, _lw, _usdc) = early_setup(crate::types::Flow::TopUp, true);
    client.release_from_funded(&id32(&env, 1));
    env.ledger().with_mut(|l| l.timestamp = 5000);

    assert_eq!(client.try_refund(&id32(&env, 1)), Err(Ok(Error::InvalidState)));

    let (env2, client2, _p2, _r2, _pw2, _lw2, _u2) = early_setup(crate::types::Flow::TopUp, true);
    env2.ledger().with_mut(|l| l.timestamp = 5000);
    client2.refund(&id32(&env2, 1));

    assert_eq!(
        client2.try_release_from_funded(&id32(&env2, 1)),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn release_from_funded_then_mark_fiat_paid_is_rejected() {
    let (env, client, _p, recipient, _pw, _lw, _usdc) = early_setup(crate::types::Flow::TopUp, true);
    client.release_from_funded(&id32(&env, 1));

    assert_eq!(
        client.try_mark_fiat_paid(&id32(&env, 1), &recipient),
        Err(Ok(Error::InvalidState))
    );
}

#[test]
fn the_provider_allowlist_is_capped() {
    let (env, client, _p, _r, _pw, _lw, _usdc) = early_setup(crate::types::Flow::TopUp, true);
    let mut cfg = client.get_config();
    let mut many = soroban_sdk::vec![&env];
    for _ in 0..(crate::MAX_EARLY_RELEASE_PROVIDERS + 1) {
        many.push_back(Address::generate(&env));
    }
    cfg.early_release_providers = many;

    assert_eq!(client.try_set_config(&cfg), Err(Ok(Error::InvalidConfig)));
}

fn early_setup_named(
    flow: crate::types::Flow,
    allow: Option<Address>,
) -> (Env, EscrowContractClient<'static>, Address, Address, Address, token::TokenClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let attestor = Address::generate(&env);
    let contract_id = env.register(
        EscrowContract,
        (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, attestor.clone()),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    if let Some(a) = allow {
        let mut cfg = client.get_config();
        cfg.early_release_providers = soroban_sdk::vec![&env, a];
        client.set_config(&cfg);
    }
    client.create_trade(
        &id32(&env, 1), &provider, &recipient, &provider, &100_0000000i128, &1i128,
        &Symbol::new(&env, "IDR"), &flow, &30u32, &120u32,
        &pw, &lw, &1000u64, &100_000u64, &200_000u64,
    );
    (env, client, provider, recipient, attestor, usdc)
}

#[test]
fn only_the_confirmer_may_release_not_the_depositor() {
    let (env, client, _p, recipient, _a, usdc) = {
        let (env, client, provider, recipient, attestor, usdc) =
            early_setup_named(crate::types::Flow::TopUp, None);
        let mut cfg = client.get_config();
        cfg.early_release_providers = soroban_sdk::vec![&env, provider.clone()];
        client.set_config(&cfg);
        (env, client, provider, recipient, attestor, usdc)
    };
    let before = usdc.balance(&recipient);

    let attestor = client.get_config().fiat_attestor;
    env.set_auths(&[]);
    let res = client
        .mock_auths(&[
            MockAuth {
                address: &attestor,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "release_from_funded",
                    args: (id32(&env, 1),).into_val(&env),
                    sub_invokes: &[],
                },
            },
            MockAuth {
                address: &recipient,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "release_from_funded",
                    args: (id32(&env, 1),).into_val(&env),
                    sub_invokes: &[],
                },
            },
        ])
        .try_release_from_funded(&id32(&env, 1));

    assert!(res.is_err());
    assert_eq!(usdc.balance(&recipient), before);
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Funded);
}

#[test]
fn an_allowlist_that_names_someone_else_does_not_open_this_trade() {
    let stranger_env = Env::default();
    let stranger = Address::generate(&stranger_env);
    let _ = stranger;
    let (env, client, _p, _r, _a, usdc) = early_setup_named(crate::types::Flow::TopUp, None);
    let someone_else = Address::generate(&env);
    let mut cfg = client.get_config();
    cfg.early_release_providers = soroban_sdk::vec![&env, someone_else];
    client.set_config(&cfg);
    let pool = usdc.balance(&client.address);

    let res = client.try_release_from_funded(&id32(&env, 1));

    assert_eq!(res, Err(Ok(Error::EarlyReleaseNotAllowed)));
    assert_eq!(usdc.balance(&client.address), pool);
}

#[test]
fn a_disputed_trade_may_not_be_released_early() {
    let (env, client, provider, recipient, _a, _usdc) =
        early_setup_named(crate::types::Flow::TopUp, None);
    let mut cfg = client.get_config();
    cfg.early_release_providers = soroban_sdk::vec![&env, provider.clone()];
    client.set_config(&cfg);
    client.mark_fiat_paid(&id32(&env, 1), &recipient);
    client.raise_dispute(&id32(&env, 1), &recipient);

    let res = client.try_release_from_funded(&id32(&env, 1));

    assert_eq!(res, Err(Ok(Error::InvalidState)));
}

#[test]
fn early_release_closes_before_the_refund_opens() {
    let (env, client, provider, _r, _a, _usdc) =
        early_setup_named(crate::types::Flow::TopUp, None);
    let mut cfg = client.get_config();
    cfg.early_release_providers = soroban_sdk::vec![&env, provider.clone()];
    client.set_config(&cfg);

    env.ledger().with_mut(|l| l.timestamp = 1000 + crate::ATTEST_GRACE_SECS);
    client.release_from_funded(&id32(&env, 1));

    let (env2, client2, provider2, _r2, _a2, _u2) =
        early_setup_named(crate::types::Flow::TopUp, None);
    let mut cfg2 = client2.get_config();
    cfg2.early_release_providers = soroban_sdk::vec![&env2, provider2.clone()];
    client2.set_config(&cfg2);
    env2.ledger().with_mut(|l| l.timestamp = 1000 + crate::ATTEST_GRACE_SECS);
    assert_eq!(client2.try_refund(&id32(&env2, 1)), Err(Ok(Error::DeadlineNotReached)));

    env2.ledger().with_mut(|l| l.timestamp = 1001 + crate::ATTEST_GRACE_SECS);
    assert_eq!(
        client2.try_release_from_funded(&id32(&env2, 1)),
        Err(Ok(Error::DeadlinePassed))
    );
    client2.refund(&id32(&env2, 1));
}

#[test]
fn early_release_announces_itself_so_the_indexer_can_see_it() {
    let (env, client, provider, _r, _a, _usdc) =
        early_setup_named(crate::types::Flow::TopUp, None);
    let mut cfg = client.get_config();
    cfg.early_release_providers = soroban_sdk::vec![&env, provider.clone()];
    client.set_config(&cfg);

    client.release_from_funded(&id32(&env, 1));

    let expected = crate::events::EarlyReleased {
        trade_id: id32(&env, 1),
        net: 985_000_000i128,
        platform_fee: 3_000_000i128,
        lp_fee: 12_000_000i128,
    };
    let raw = env.events().all().filter_by_contract(&client.address);
    let raw = raw.events();
    assert_eq!(raw[raw.len() - 1], expected.to_xdr(&env, &client.address));
}

#[test]
fn early_release_needs_the_attestor_signature_as_well_as_the_providers() {
    let (env, client, provider, _r, attestor, _usdc) =
        early_setup_named(crate::types::Flow::TopUp, None);
    let mut cfg = client.get_config();
    cfg.early_release_providers = soroban_sdk::vec![&env, provider.clone()];
    client.set_config(&cfg);

    env.set_auths(&[]);
    let without_attestor = client
        .mock_auths(&[MockAuth {
            address: &provider,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "release_from_funded",
                args: (id32(&env, 1),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_release_from_funded(&id32(&env, 1));
    assert!(without_attestor.is_err());
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Funded);

    let both = [
        MockAuth {
            address: &attestor,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "release_from_funded",
                args: (id32(&env, 1),).into_val(&env),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &provider,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "release_from_funded",
                args: (id32(&env, 1),).into_val(&env),
                sub_invokes: &[],
            },
        },
    ];
    client.mock_auths(&both).release_from_funded(&id32(&env, 1));
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Released);
}

fn resolver_setup() -> (
    Env, EscrowContractClient<'static>, Address, Address, Address, token::TokenClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let attestor = Address::generate(&env);
    let contract_id = env.register(
        EscrowContract,
        (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, attestor.clone()),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    client.create_trade(
        &id32(&env, 1), &provider, &recipient, &provider, &100_0000000i128, &1i128,
        &Symbol::new(&env, "IDR"), &crate::types::Flow::TopUp, &30u32, &120u32,
        &pw, &lw, &1000u64, &2000u64, &3000u64,
    );
    (env, client, resolver, provider, recipient, usdc)
}

#[test]
fn the_resolver_may_dispute_a_funded_trade() {
    let (env, client, resolver, _p, _r, _usdc) = resolver_setup();

    client.raise_dispute(&id32(&env, 1), &resolver);

    let trade = client.get_trade(&id32(&env, 1));
    assert_eq!(trade.status, crate::types::Status::Disputed);
    assert_eq!(trade.disputed_by, Some(resolver));
}

#[test]
fn the_audit_trail_never_claims_a_party_complained_when_they_did_not() {
    let (env, client, resolver, provider, recipient, _usdc) = resolver_setup();

    client.raise_dispute(&id32(&env, 1), &resolver);

    let disputed_by = client.get_trade(&id32(&env, 1)).disputed_by;
    assert_ne!(disputed_by, Some(provider));
    assert_ne!(disputed_by, Some(recipient));
}

#[test]
fn a_disputed_funded_trade_cannot_be_refunded() {
    let (env, client, resolver, _p, _r, usdc) = resolver_setup();
    let pool = usdc.balance(&client.address);
    client.raise_dispute(&id32(&env, 1), &resolver);

    env.ledger().with_mut(|l| l.timestamp = 5000);

    assert_eq!(client.try_refund(&id32(&env, 1)), Err(Ok(Error::InvalidState)));
    assert_eq!(usdc.balance(&client.address), pool);
}

#[test]
fn a_stranger_cannot_dispute_a_funded_trade() {
    let (env, client, _resolver, _p, _r, _usdc) = resolver_setup();
    let stranger = Address::generate(&env);

    assert_eq!(
        client.try_raise_dispute(&id32(&env, 1), &stranger),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn neither_party_may_dispute_a_funded_trade_so_the_refund_survives() {
    let (env, client, _resolver, provider, recipient, _usdc) = resolver_setup();

    for who in [&provider, &recipient] {
        assert_eq!(
            client.try_raise_dispute(&id32(&env, 1), who),
            Err(Ok(Error::Unauthorized))
        );
    }

    env.ledger().with_mut(|l| l.timestamp = 5000);
    client.refund(&id32(&env, 1));
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Refunded);
}

#[test]
fn the_resolver_may_dispute_a_trade_released_from_funded() {
    let (env, client, resolver, provider, recipient, usdc) = resolver_setup();
    let mut cfg = client.get_config();
    cfg.early_release_providers = soroban_sdk::vec![&env, provider.clone()];
    client.set_config(&cfg);
    env.ledger().with_mut(|l| l.timestamp = 500);
    client.release_from_funded(&id32(&env, 1));
    let after_release = usdc.balance(&recipient);

    client.raise_dispute(&id32(&env, 1), &resolver);

    let trade = client.get_trade(&id32(&env, 1));
    assert_eq!(trade.status, crate::types::Status::Disputed);
    assert_eq!(trade.disputed_by, Some(resolver));
    assert_eq!(usdc.balance(&recipient), after_release);
}

#[test]
fn a_party_may_still_dispute_once_the_fiat_is_marked_paid() {
    let (env, client, _resolver, _p, recipient, _usdc) = resolver_setup();
    client.mark_fiat_paid(&id32(&env, 1), &recipient);

    client.raise_dispute(&id32(&env, 1), &recipient);

    assert_eq!(client.get_trade(&id32(&env, 1)).disputed_by, Some(recipient));
}

#[test]
fn naming_the_resolver_is_not_the_same_as_being_the_resolver() {
    let (env, client, resolver, _p, _r, _usdc) = resolver_setup();

    env.set_auths(&[]);
    let res = client.try_raise_dispute(&id32(&env, 1), &resolver);

    assert!(res.is_err());
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Funded);
}

#[test]
fn naming_a_party_is_not_the_same_as_being_one() {
    let (env, client, _resolver, _p, recipient, _usdc) = resolver_setup();
    client.mark_fiat_paid(&id32(&env, 1), &recipient);

    env.set_auths(&[]);
    let res = client.try_raise_dispute(&id32(&env, 1), &recipient);

    assert!(res.is_err());
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::FiatPaid);
}

fn disputed_from_funded() -> (
    Env, EscrowContractClient<'static>, Address, Address, Address, Address, token::TokenClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);
    let attestor = Address::generate(&env);
    let contract_id = env.register(
        EscrowContract,
        (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, attestor.clone()),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let lw = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    client.create_trade(
        &id32(&env, 1), &provider, &recipient, &provider, &100_0000000i128, &1i128,
        &Symbol::new(&env, "IDR"), &crate::types::Flow::TopUp, &30u32, &120u32,
        &pw, &lw, &1000u64, &2000u64, &3000u64,
    );
    client.raise_dispute(&id32(&env, 1), &resolver);
    (env, client, resolver, attestor, provider, recipient, usdc)
}


#[test]
fn the_resolver_alone_cannot_settle_a_trade_it_disputed_from_funded() {
    let (env, client, resolver, _attestor, provider, recipient, usdc) = disputed_from_funded();
    let before = (usdc.balance(&provider), usdc.balance(&recipient), usdc.balance(&client.address));

    env.set_auths(&[]);
    let released = client
        .mock_auths(&[MockAuth {
            address: &resolver,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "resolve",
                args: (id32(&env, 1), crate::types::ResolveOutcome::Release, resolver.clone())
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Release, &resolver);

    assert!(released.is_err());
    assert_eq!(
        (usdc.balance(&provider), usdc.balance(&recipient), usdc.balance(&client.address)),
        before
    );
}

#[test]
fn the_attestor_and_the_resolver_together_may_settle_it() {
    let (env, client, resolver, _attestor, _provider, recipient, usdc) = disputed_from_funded();

    client.resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Release, &resolver);

    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Released);
    assert_eq!(usdc.balance(&recipient), 985_000_000i128);
}

#[test]
fn refunding_a_funded_origin_dispute_returns_the_provider_their_capital() {
    let (env, client, resolver, _a, provider, _r, usdc) = disputed_from_funded();

    client.resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Refund, &resolver);

    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Refunded);
    assert_eq!(usdc.balance(&provider), 100_0000000i128);
}

#[test]
fn pausing_stops_a_funded_trade_being_dragged_into_dispute() {
    let (env, client, resolver, _p, _r, _usdc) = resolver_setup();
    client.set_paused(&true);

    assert_eq!(
        client.try_raise_dispute(&id32(&env, 1), &resolver),
        Err(Ok(Error::Paused))
    );
}

#[test]
fn a_funded_trade_cannot_be_disputed_once_its_dispute_deadline_has_passed() {
    let (env, client, resolver, _p, _r, _usdc) = resolver_setup();
    env.ledger().with_mut(|l| l.timestamp = 3001);

    assert_eq!(
        client.try_raise_dispute(&id32(&env, 1), &resolver),
        Err(Ok(Error::DeadlinePassed))
    );
}

#[test]
fn a_post_settlement_dispute_is_still_verdict_only() {
    let (env, client, resolver, _p, recipient, usdc) = resolver_setup();
    client.mark_fiat_paid(&id32(&env, 1), &recipient);
    env.ledger().with_mut(|l| l.timestamp = 500);
    client.confirm_and_release(&id32(&env, 1));
    let after = usdc.balance(&recipient);

    client.raise_dispute(&id32(&env, 1), &resolver);
    client.resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Refund, &resolver);

    assert_eq!(usdc.balance(&recipient), after);
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Released);
}

#[test]
fn a_resolver_raised_post_settlement_dispute_does_not_burn_the_parties_own_right() {
    let (env, client, resolver, _p, recipient, _usdc) = resolver_setup();
    client.mark_fiat_paid(&id32(&env, 1), &recipient);
    env.ledger().with_mut(|l| l.timestamp = 500);
    client.confirm_and_release(&id32(&env, 1));

    client.raise_dispute(&id32(&env, 1), &resolver);
    client.resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Release, &resolver);

    client.raise_dispute(&id32(&env, 1), &recipient);
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Disputed);
}

#[test]
fn a_party_raised_post_settlement_dispute_is_still_one_shot() {
    let (env, client, resolver, _p, recipient, _usdc) = resolver_setup();
    client.mark_fiat_paid(&id32(&env, 1), &recipient);
    env.ledger().with_mut(|l| l.timestamp = 500);
    client.confirm_and_release(&id32(&env, 1));

    client.raise_dispute(&id32(&env, 1), &recipient);
    client.resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Release, &resolver);

    assert_eq!(
        client.try_raise_dispute(&id32(&env, 1), &recipient),
        Err(Ok(Error::AlreadyResolved))
    );
}

#[test]
#[should_panic]
fn the_admin_and_the_resolver_may_not_be_the_same_key() {
    let env = Env::default();
    env.mock_all_auths();
    let shared = Address::generate(&env);
    let usdc = Address::generate(&env);
    let pw = Address::generate(&env);
    let attestor = Address::generate(&env);

    env.register(
        EscrowContract,
        (shared.clone(), usdc.clone(), shared.clone(), 30u32, pw.clone(), 3600u64, attestor.clone()),
    );
}

#[test]
fn configuration_may_not_collapse_the_admin_and_resolver_together() {
    let (_env, client, admin, _usdc, _resolver, _pw) = setup();
    let mut cfg = client.get_config();
    cfg.resolver = admin;

    assert_eq!(client.try_set_config(&cfg), Err(Ok(Error::InvalidConfig)));
}

fn gate_setup() -> (
    Env,
    EscrowContractClient<'static>,
    Address,
    Address,
    Address,
    Address,
    Address,
    token::TokenClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (usdc, usdc_admin) = create_usdc(&env, &admin);
    let resolver = Address::generate(&env);
    let attestor = Address::generate(&env);
    let pw = Address::generate(&env);
    let contract_id = env.register(
        EscrowContract,
        (admin.clone(), usdc.address.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, attestor.clone()),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    usdc_admin.mint(&provider, &100_0000000i128);
    (env, client, admin, resolver, attestor, provider, recipient, usdc)
}

fn gate_trade(
    env: &Env,
    client: &EscrowContractClient<'static>,
    provider: &Address,
    recipient: &Address,
    flow: crate::types::Flow,
    id: u8,
) {
    let pw = client.get_config().default_platform_wallet;
    let lw = Address::generate(env);
    client.create_trade(
        &id32(env, id), provider, recipient, provider, &100_0000000i128, &1i128,
        &Symbol::new(env, "IDR"), &flow, &30u32, &120u32,
        &pw, &lw, &1000u64, &2000u64, &3000u64,
    );
}

#[test]
#[should_panic]
fn the_attestor_may_not_be_the_resolver() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let usdc = Address::generate(&env);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);

    env.register(
        EscrowContract,
        (admin.clone(), usdc.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, resolver.clone()),
    );
}

#[test]
#[should_panic]
fn the_attestor_may_not_be_the_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let usdc = Address::generate(&env);
    let resolver = Address::generate(&env);
    let pw = Address::generate(&env);

    env.register(
        EscrowContract,
        (admin.clone(), usdc.clone(), resolver.clone(), 30u32, pw.clone(), 3600u64, admin.clone()),
    );
}

#[test]
fn the_admin_may_not_reappoint_the_resolver_onto_the_attestor() {
    let (_env, client, _admin, _resolver, attestor, _p, _r, _usdc) = gate_setup();
    let mut cfg = client.get_config();
    cfg.resolver = attestor.clone();

    assert_eq!(client.try_set_config(&cfg), Err(Ok(Error::InvalidConfig)));
    assert_ne!(client.get_config().resolver, attestor);
}

#[test]
fn the_admin_may_not_hand_the_admin_role_to_the_attestor() {
    let (_env, client, _admin, _resolver, attestor, _p, _r, _usdc) = gate_setup();
    let mut cfg = client.get_config();
    cfg.admin = attestor.clone();

    assert_eq!(client.try_set_config(&cfg), Err(Ok(Error::InvalidConfig)));
    assert_ne!(client.get_config().admin, attestor);
}

#[test]
fn a_funded_withdrawal_cannot_be_dragged_into_a_dispute() {
    let (env, client, _admin, resolver, _attestor, provider, recipient, usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::Withdraw, 1);
    let before = usdc.balance(&recipient);

    assert_eq!(
        client.try_raise_dispute(&id32(&env, 1), &resolver),
        Err(Ok(Error::DisputeNotAllowed))
    );

    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Funded);
    assert_eq!(usdc.balance(&recipient), before);
}

#[test]
fn a_funded_dispute_leaves_no_origin_latched_behind_it() {
    let (env, client, _admin, resolver, _attestor, provider, recipient, _usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);
    client.raise_dispute(&id32(&env, 1), &resolver);
    env.ledger().with_mut(|l| l.timestamp = 500);

    client.resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Release, &resolver);

    let trade = client.get_trade(&id32(&env, 1));
    assert!(!trade.has_pre_dispute_status);
    let (_d, _p, _r, _a, pre_settlement, _rel, _dl) = client.dispute_view(&id32(&env, 1));
    assert!(!pre_settlement);
}

#[test]
fn the_admin_can_unwind_a_funded_dispute_without_the_attestor() {
    let (env, client, admin, resolver, _attestor, provider, recipient, usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);
    client.raise_dispute(&id32(&env, 1), &resolver);
    let before = usdc.balance(&provider);
    let deadline = client.get_trade(&id32(&env, 1)).resolver_deadline;
    env.ledger().with_mut(|l| l.timestamp = deadline + 1);

    env.set_auths(&[]);
    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "resolve",
                args: (id32(&env, 1), crate::types::ResolveOutcome::Refund, admin.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Refund, &admin);

    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Refunded);
    assert_eq!(usdc.balance(&provider), before + 100_0000000i128);
    assert_eq!(usdc.balance(&client.address), 0);
}

#[test]
fn the_admin_unwind_is_a_refund_only_never_a_release() {
    let (env, client, admin, resolver, _attestor, provider, recipient, usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);
    client.raise_dispute(&id32(&env, 1), &resolver);
    let before = usdc.balance(&recipient);
    let deadline = client.get_trade(&id32(&env, 1)).resolver_deadline;
    env.ledger().with_mut(|l| l.timestamp = deadline + 1);

    env.set_auths(&[]);
    let res = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "resolve",
                args: (id32(&env, 1), crate::types::ResolveOutcome::Release, admin.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Release, &admin);

    assert!(res.is_err());
    assert_eq!(usdc.balance(&recipient), before);
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Disputed);
}

#[test]
fn the_resolvers_post_settlement_dispute_does_not_consume_the_parties_own() {
    let (env, client, _admin, resolver, _attestor, provider, recipient, _usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);
    client.mark_fiat_paid(&id32(&env, 1), &recipient);
    env.ledger().with_mut(|l| l.timestamp = 500);
    client.confirm_and_release(&id32(&env, 1));

    client.raise_dispute(&id32(&env, 1), &resolver);
    client.resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Release, &resolver);
    assert!(!client.get_trade(&id32(&env, 1)).post_settle_resolved);
    assert!(client.get_trade(&id32(&env, 1)).resolver_post_settle_used);

    assert_eq!(
        client.try_raise_dispute(&id32(&env, 1), &resolver),
        Err(Ok(Error::AlreadyResolved))
    );

    client.raise_dispute(&id32(&env, 1), &recipient);
    client.resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Release, &resolver);
    assert!(client.get_trade(&id32(&env, 1)).post_settle_resolved);
}

#[test]
fn a_partys_spent_dispute_is_not_restored_by_a_later_resolver_one() {
    let (env, client, _admin, resolver, _attestor, provider, recipient, _usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);
    client.mark_fiat_paid(&id32(&env, 1), &recipient);
    env.ledger().with_mut(|l| l.timestamp = 500);
    client.confirm_and_release(&id32(&env, 1));

    client.raise_dispute(&id32(&env, 1), &recipient);
    client.resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Release, &resolver);
    client.raise_dispute(&id32(&env, 1), &resolver);
    client.resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Release, &resolver);

    assert!(client.get_trade(&id32(&env, 1)).post_settle_resolved);
    assert_eq!(
        client.try_raise_dispute(&id32(&env, 1), &recipient),
        Err(Ok(Error::AlreadyResolved))
    );
}

#[test]
fn widening_the_dispute_window_does_not_reopen_a_settled_trade() {
    let (env, client, _admin, resolver, _attestor, provider, recipient, _usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);
    client.mark_fiat_paid(&id32(&env, 1), &recipient);
    env.ledger().with_mut(|l| l.timestamp = 500);
    client.confirm_and_release(&id32(&env, 1));
    assert_eq!(client.get_trade(&id32(&env, 1)).post_settle_deadline, 4100);

    env.ledger().with_mut(|l| l.timestamp = 4101);
    let mut cfg = client.get_config();
    cfg.dispute_window = 604_800;
    client.set_config(&cfg);

    assert_eq!(
        client.try_raise_dispute(&id32(&env, 1), &resolver),
        Err(Ok(Error::DisputeWindowPassed))
    );
}

#[test]
fn a_deposit_refund_opens_the_instant_attestation_closes() {
    let (env, client, _admin, _resolver, attestor, provider, recipient, usdc) = gate_setup();
    let pw = client.get_config().default_platform_wallet;
    let lw = Address::generate(&env);
    for id in [1u8, 2u8] {
        client.create_trade(
            &id32(&env, id), &provider, &recipient, &provider, &10_0000000i128, &1i128,
            &Symbol::new(&env, "IDR"), &crate::types::Flow::TopUp, &30u32, &120u32,
            &pw, &lw, &1000u64, &1001u64, &3000u64,
        );
    }

    env.ledger().with_mut(|l| l.timestamp = 1001);
    client.mark_fiat_paid(&id32(&env, 1), &attestor);
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::FiatPaid);
    assert_eq!(
        client.try_refund(&id32(&env, 2)),
        Err(Ok(Error::DeadlineNotReached))
    );

    env.ledger().with_mut(|l| l.timestamp = 1002);
    assert_eq!(
        client.try_mark_fiat_paid(&id32(&env, 2), &attestor),
        Err(Ok(Error::DeadlinePassed))
    );
    let before = usdc.balance(&provider);
    client.refund(&id32(&env, 2));
    assert_eq!(usdc.balance(&provider), before + 10_0000000i128);
}

#[test]
fn cancel_needs_both_parties_not_just_the_provider() {
    let (env, client, _admin, _resolver, _attestor, provider, recipient, usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);
    let before = usdc.balance(&provider);

    env.set_auths(&[]);
    let res = client
        .mock_auths(&[MockAuth {
            address: &provider,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "cancel",
                args: (id32(&env, 1),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_cancel(&id32(&env, 1));

    assert!(res.is_err());
    assert_eq!(usdc.balance(&provider), before);
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Funded);
}

#[test]
fn set_config_needs_the_sitting_admins_signature_not_the_incoming_ones() {
    let (env, client, _admin, _resolver, _attestor, _p, _r, _usdc) = gate_setup();
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
fn the_provider_allowlist_accepts_twenty_and_refuses_twenty_one() {
    let (env, client, _admin, _resolver, _attestor, _p, _r, _usdc) = gate_setup();

    let mut twenty = soroban_sdk::Vec::new(&env);
    for _ in 0..20 {
        twenty.push_back(Address::generate(&env));
    }
    let mut cfg = client.get_config();
    cfg.early_release_providers = twenty.clone();
    client.set_config(&cfg);
    assert_eq!(client.get_config().early_release_providers.len(), 20);

    let mut twenty_one = twenty;
    twenty_one.push_back(Address::generate(&env));
    let mut cfg = client.get_config();
    cfg.early_release_providers = twenty_one;
    assert_eq!(client.try_set_config(&cfg), Err(Ok(Error::InvalidConfig)));
    assert_eq!(client.get_config().early_release_providers.len(), 20);
}

#[test]
fn the_admin_role_cannot_be_pushed_onto_an_address_that_never_consented() {
    let (env, client, admin, _resolver, _attestor, _p, _r, _usdc) = gate_setup();
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
fn the_resolver_alone_cannot_refund_a_funded_dispute_either() {
    let (env, client, _admin, resolver, _attestor, provider, recipient, usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);
    client.raise_dispute(&id32(&env, 1), &resolver);
    let before = (usdc.balance(&provider), usdc.balance(&recipient), usdc.balance(&client.address));

    env.set_auths(&[]);
    let res = client
        .mock_auths(&[MockAuth {
            address: &resolver,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "resolve",
                args: (id32(&env, 1), crate::types::ResolveOutcome::Refund, resolver.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Refund, &resolver);

    assert!(res.is_err());
    assert_eq!(
        (usdc.balance(&provider), usdc.balance(&recipient), usdc.balance(&client.address)),
        before
    );
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Disputed);
}

#[test]
fn the_admin_unwind_does_not_open_one_second_early() {
    let (env, client, admin, resolver, _attestor, provider, recipient, usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);
    client.raise_dispute(&id32(&env, 1), &resolver);
    let deadline = client.get_trade(&id32(&env, 1)).resolver_deadline;
    let before = usdc.balance(&provider);
    env.ledger().with_mut(|l| l.timestamp = deadline);

    env.set_auths(&[]);
    let res = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "resolve",
                args: (id32(&env, 1), crate::types::ResolveOutcome::Refund, admin.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Refund, &admin);

    assert_eq!(res, Err(Ok(Error::Unauthorized)));
    assert_eq!(usdc.balance(&provider), before);
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Disputed);
}

#[test]
fn the_resolver_gets_no_second_post_settlement_dispute_after_a_party_took_one() {
    let (env, client, _admin, resolver, _attestor, provider, recipient, _usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);
    client.mark_fiat_paid(&id32(&env, 1), &recipient);
    env.ledger().with_mut(|l| l.timestamp = 500);
    client.confirm_and_release(&id32(&env, 1));

    client.raise_dispute(&id32(&env, 1), &resolver);
    client.resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Release, &resolver);
    client.raise_dispute(&id32(&env, 1), &recipient);
    client.resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Release, &resolver);

    let trade = client.get_trade(&id32(&env, 1));
    assert!(trade.resolver_post_settle_used);
    assert!(trade.post_settle_resolved);
    assert_eq!(
        client.try_raise_dispute(&id32(&env, 1), &resolver),
        Err(Ok(Error::AlreadyResolved))
    );
}

#[test]
fn resolving_a_dispute_to_a_release_latches_its_own_dispute_window() {
    let (env, client, _admin, resolver, _attestor, provider, recipient, _usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);
    client.mark_fiat_paid(&id32(&env, 1), &recipient);
    client.raise_dispute(&id32(&env, 1), &recipient);
    env.ledger().with_mut(|l| l.timestamp = 700);

    client.resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Release, &resolver);

    let trade = client.get_trade(&id32(&env, 1));
    assert_eq!(trade.settled_at, 700);
    assert_eq!(trade.post_settle_deadline, 700 + 3600);

    env.ledger().with_mut(|l| l.timestamp = 4300);
    client.raise_dispute(&id32(&env, 1), &provider);
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Disputed);
}

#[test]
fn a_dispute_resolved_to_a_refund_latches_its_window_too() {
    let (env, client, _admin, resolver, _attestor, provider, recipient, _usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);
    client.mark_fiat_paid(&id32(&env, 1), &recipient);
    client.raise_dispute(&id32(&env, 1), &recipient);
    env.ledger().with_mut(|l| l.timestamp = 700);

    client.resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Refund, &resolver);

    let trade = client.get_trade(&id32(&env, 1));
    assert_eq!(trade.settled_at, 700);
    assert_eq!(trade.post_settle_deadline, 700 + 3600);

    env.ledger().with_mut(|l| l.timestamp = 4301);
    assert_eq!(
        client.try_raise_dispute(&id32(&env, 1), &provider),
        Err(Ok(Error::DisputeWindowPassed))
    );
}

#[test]
fn a_resolver_that_is_also_a_party_cannot_be_given_a_trade() {
    let (env, client, _admin, resolver, _attestor, provider, _r, _usdc) = gate_setup();
    let pw = client.get_config().default_platform_wallet;
    let lw = Address::generate(&env);

    let res = client.try_create_trade(
        &id32(&env, 9), &provider, &resolver, &provider, &100_0000000i128, &1i128,
        &Symbol::new(&env, "IDR"), &crate::types::Flow::TopUp, &30u32, &120u32,
        &pw, &lw, &1000u64, &2000u64, &3000u64,
    );

    assert_eq!(res, Err(Ok(Error::InvalidRoles)));
}

#[test]
fn an_attestor_may_not_be_a_party_to_the_trade_it_witnesses() {
    let (env, client, _admin, _resolver, attestor, provider, _r, _usdc) = gate_setup();
    let pw = client.get_config().default_platform_wallet;
    let lw = Address::generate(&env);

    let res = client.try_create_trade(
        &id32(&env, 9), &provider, &attestor, &provider, &100_0000000i128, &1i128,
        &Symbol::new(&env, "IDR"), &crate::types::Flow::TopUp, &30u32, &120u32,
        &pw, &lw, &1000u64, &2000u64, &3000u64,
    );

    assert_eq!(res, Err(Ok(Error::InvalidRoles)));
}

#[test]
fn a_resolver_rotated_onto_a_party_still_spends_its_own_dispute_slot() {
    let (env, client, admin, _resolver, _attestor, provider, recipient, _usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);
    client.mark_fiat_paid(&id32(&env, 1), &recipient);
    env.ledger().with_mut(|l| l.timestamp = 500);
    client.confirm_and_release(&id32(&env, 1));

    let mut cfg = client.get_config();
    cfg.resolver = recipient.clone();
    cfg.admin = admin.clone();
    client.set_config(&cfg);

    client.raise_dispute(&id32(&env, 1), &recipient);
    client.resolve(&id32(&env, 1), &crate::types::ResolveOutcome::Release, &recipient);

    let trade = client.get_trade(&id32(&env, 1));
    assert!(trade.resolver_post_settle_used);
    assert!(!trade.post_settle_resolved);
    assert_eq!(
        client.try_raise_dispute(&id32(&env, 1), &recipient),
        Err(Ok(Error::AlreadyResolved))
    );
    client.raise_dispute(&id32(&env, 1), &provider);
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Disputed);
}

#[test]
fn the_resolver_window_is_a_full_day() {
    let (env, client, _admin, resolver, _attestor, provider, recipient, _usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);

    client.raise_dispute(&id32(&env, 1), &resolver);

    assert_eq!(client.get_trade(&id32(&env, 1)).resolver_deadline, 86_400);
}

#[test]
fn the_attestation_grace_is_one_hour() {
    let (env, client, _admin, _resolver, attestor, provider, recipient, _usdc) = gate_setup();
    let pw = client.get_config().default_platform_wallet;
    let lw = Address::generate(&env);
    client.create_trade(
        &id32(&env, 1), &provider, &recipient, &provider, &10_0000000i128, &1i128,
        &Symbol::new(&env, "IDR"), &crate::types::Flow::TopUp, &30u32, &120u32,
        &pw, &lw, &1000u64, &20_000u64, &30_000u64,
    );

    env.ledger().with_mut(|l| l.timestamp = 4600);
    client.mark_fiat_paid(&id32(&env, 1), &attestor);

    client.create_trade(
        &id32(&env, 2), &provider, &recipient, &provider, &10_0000000i128, &1i128,
        &Symbol::new(&env, "IDR"), &crate::types::Flow::TopUp, &30u32, &120u32,
        &pw, &lw, &10_000u64, &40_000u64, &50_000u64,
    );
    env.ledger().with_mut(|l| l.timestamp = 13_601);
    assert_eq!(
        client.try_mark_fiat_paid(&id32(&env, 2), &attestor),
        Err(Ok(Error::DeadlinePassed))
    );
}

#[test]
fn a_funded_dispute_is_still_open_on_the_deadline_second_itself() {
    let (env, client, _admin, resolver, _attestor, provider, recipient, _usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);
    env.ledger().with_mut(|l| l.timestamp = 3000);

    client.raise_dispute(&id32(&env, 1), &resolver);

    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Disputed);
}

#[test]
fn a_settlement_is_recognised_by_its_status_not_by_the_clock() {
    let (env, client, _admin, _resolver, _attestor, provider, recipient, _usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::TopUp, 1);
    client.mark_fiat_paid(&id32(&env, 1), &recipient);

    client.confirm_and_release(&id32(&env, 1));

    let trade = client.get_trade(&id32(&env, 1));
    assert_eq!(trade.status, crate::types::Status::Released);
    assert_eq!(trade.settled_at, 0);
    let (_d, _p, _r, _a, pre_settlement, released, _dl) = client.dispute_view(&id32(&env, 1));
    assert!(!pre_settlement);
    assert!(released);
}

#[test]
fn a_late_paying_provider_of_rupiah_is_not_robbed_by_the_clock() {
    let (env, client, _admin, _resolver, _attestor, provider, recipient, usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::Withdraw, 1);
    let lp_before = usdc.balance(&recipient);

    env.ledger().with_mut(|l| l.timestamp = 1500);
    assert_eq!(
        client.try_refund(&id32(&env, 1)),
        Err(Ok(Error::DeadlineNotReached))
    );
    client.mark_fiat_paid(&id32(&env, 1), &recipient);
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::FiatPaid);

    client.confirm_and_release(&id32(&env, 1));
    assert_eq!(usdc.balance(&recipient), lp_before + 98_5000000i128);
}

#[test]
fn the_withdrawal_marking_window_closes_exactly_where_its_refund_opens() {
    let (env, client, _admin, _resolver, _attestor, provider, recipient, _usdc) = gate_setup();
    gate_trade(&env, &client, &provider, &recipient, crate::types::Flow::Withdraw, 1);

    env.ledger().with_mut(|l| l.timestamp = 2000);
    assert_eq!(
        client.try_refund(&id32(&env, 1)),
        Err(Ok(Error::DeadlineNotReached))
    );

    env.ledger().with_mut(|l| l.timestamp = 2001);
    assert_eq!(
        client.try_mark_fiat_paid(&id32(&env, 1), &recipient),
        Err(Ok(Error::DeadlinePassed))
    );
    client.refund(&id32(&env, 1));
    assert_eq!(client.get_trade(&id32(&env, 1)).status, crate::types::Status::Refunded);
}
