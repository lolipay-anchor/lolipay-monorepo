import { KycStatus, OrderStatus } from '../generated/prisma/client';
import type { Sep24Status } from './sep24-status';
import { baseUnitsToUsdcString, fiatDigits } from '../money/money';

export type InteractiveScreen =
  | 'identity'
  | 'waiting_on_identity'
  | 'refused'
  | 'amount'
  | 'waiting_on_escrow'
  | 'waiting_on_fiat'
  | 'sign_funding'
  | 'sign_release'
  | 'instructions'
  | 'settled';

export function interactiveScreen(input: {
  kycStatus: KycStatus | null;
  screened: boolean;
  orderStatus: OrderStatus | null;
  flow?: 'TOP_UP' | 'WITHDRAW';
}): InteractiveScreen {
  if (input.kycStatus === 'REJECTED') return 'refused';
  if (input.kycStatus === null || input.kycStatus === 'NEEDS_INFO') return 'identity';
  if (!input.screened) return 'waiting_on_identity';
  if (input.orderStatus === null) return 'amount';
  const withdrawing = input.flow === 'WITHDRAW';
  if (input.orderStatus === 'CREATED' || input.orderStatus === 'MATCHED' || input.orderStatus === 'AWAITING_ONCHAIN') {
    if (withdrawing && input.orderStatus !== 'CREATED') return 'sign_funding';
    return 'waiting_on_escrow';
  }
  if (input.orderStatus === 'FUNDED') return withdrawing ? 'waiting_on_fiat' : 'instructions';
  if (input.orderStatus === 'FIAT_PAID' && withdrawing) return 'sign_release';
  return 'settled';
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const STYLE = [
  'body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#111;background:#fff}',
  'main{max-width:26rem;margin:0 auto;padding:1.25rem}',
  '.brand{font-weight:700;letter-spacing:.02em;color:#555;margin:0 0 .5rem}',
  'h1{font-size:1.35rem;margin:.25rem 0 1rem}',
  'label{display:block;margin:.75rem 0 .25rem;font-weight:600}',
  'input,select{width:100%;font:inherit;font-weight:400;padding:.6rem;border:1px solid #bbb;border-radius:.5rem;box-sizing:border-box}',
  'button,.btn{display:block;width:100%;min-height:44px;margin-top:1rem;font:inherit;font-weight:600;border:0;border-radius:.5rem;background:#111;color:#fff;text-align:center;text-decoration:none;padding:.75rem;box-sizing:border-box}',
  '.hint{color:#555;font-size:.9rem}',
  'pre,code{white-space:pre-wrap;overflow-wrap:break-word;overflow-wrap:anywhere}',
].join('');

export function page(title: string, body: string, refreshSecs?: number): string {
  const refresh = refreshSecs ? `<meta http-equiv="refresh" content="${refreshSecs}">` : '';
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<style>${STYLE}</style>`,
    refresh,
    `<title>${escapeHtml(title)}</title></head><body>`,
    `<main><p class="brand">lolipay</p><h1>${escapeHtml(title)}</h1>`,
    body,
    '</main></body></html>',
  ].join('');
}

const IDENTITY_FIELDS: Record<string, string> = {
  first_name: '<label for="first_name">First name</label><input id="first_name" name="first_name" required autocomplete="given-name">',
  last_name: '<label for="last_name">Last name</label><input id="last_name" name="last_name" required autocomplete="family-name">',
  email_address: '<label for="email_address">Email address</label><input id="email_address" name="email_address" type="email" required autocomplete="email">',
  id_type:
    '<label for="id_type">Identity document</label><select id="id_type" name="id_type">' +
    '<option value="id_card" selected>KTP / national ID card</option>' +
    '<option value="passport">Passport</option>' +
    '<option value="drivers_license">Driving licence</option>' +
    '</select>',
  id_country_code:
    '<label for="id_country_code">Country that issued it (3-letter code)</label><input id="id_country_code" name="id_country_code" value="IDN" pattern="[A-Za-z]{3}" maxlength="3" autocapitalize="characters" required>',
};

export function identityField(name: string): string {
  const safe = escapeHtml(name);
  return IDENTITY_FIELDS[name] ?? `<label for="${safe}">${escapeHtml(name.replace(/_/g, ' '))}</label><input id="${safe}" name="${safe}" required>`;
}

export function formatFiat(amount: unknown): string {
  const digits = fiatDigits(amount);
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function formatUsdc(units: bigint): string {
  return baseUnitsToUsdcString(units).replace(/\.?0+$/, '');
}

export function effectiveIdrPerUsdc(fiatAmount: bigint, usdcAmount: bigint): bigint {
  if (usdcAmount <= 0n) return 0n;
  return (fiatAmount * 10_000_000n + usdcAmount / 2n) / usdcAmount;
}

export function settledRefreshSecs(status: Sep24Status): number | undefined {
  return status === 'completed' || status === 'refunded' || status === 'expired' ? undefined : 15;
}
