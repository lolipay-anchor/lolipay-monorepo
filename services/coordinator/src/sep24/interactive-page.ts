import { KycStatus, OrderStatus } from '../generated/prisma/client';
import { fiatDigits } from '../money/money';

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

export function page(title: string, body: string, refreshSecs?: number): string {
  const refresh = refreshSecs ? `<meta http-equiv="refresh" content="${refreshSecs}">` : '';
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    refresh,
    `<title>${escapeHtml(title)}</title></head><body>`,
    `<h1>${escapeHtml(title)}</h1>`,
    body,
    '</body></html>',
  ].join('');
}

export function formatFiat(amount: unknown): string {
  const digits = fiatDigits(amount);
  if (digits.length === 0) return '';
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
