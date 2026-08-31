import { KycStatus, OrderStatus } from '../generated/prisma/client';

export type InteractiveScreen =
  | 'identity'
  | 'waiting_on_identity'
  | 'refused'
  | 'amount'
  | 'waiting_on_escrow'
  | 'instructions'
  | 'settled';

export function interactiveScreen(input: {
  kycStatus: KycStatus | null;
  screened: boolean;
  orderStatus: OrderStatus | null;
}): InteractiveScreen {
  if (input.kycStatus === 'REJECTED') return 'refused';
  if (input.kycStatus === null || input.kycStatus === 'NEEDS_INFO') return 'identity';
  if (!input.screened) return 'waiting_on_identity';
  if (input.orderStatus === null) return 'amount';
  if (input.orderStatus === 'CREATED' || input.orderStatus === 'MATCHED' || input.orderStatus === 'AWAITING_ONCHAIN') {
    return 'waiting_on_escrow';
  }
  if (input.orderStatus === 'FUNDED') return 'instructions';
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
  const digits = String(amount ?? '').replace(/[^0-9]/g, '');
  if (digits.length === 0) return '';
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
