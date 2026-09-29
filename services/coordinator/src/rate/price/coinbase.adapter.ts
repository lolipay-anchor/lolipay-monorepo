import { Injectable } from '@nestjs/common';
import { PriceAdapter } from './price.types';
import { sanitizeForLog } from './log-sanitizer';

const FETCH_TIMEOUT_MS = 5_000;
const COINBASE_URL = 'https://api.coinbase.com/v2/exchange-rates?currency=USDC';
const COINBASE_DECIMAL_RATE_RE = /^\d+(\.\d+)?$/;

@Injectable()
export class CoinbaseAdapter implements PriceAdapter {
  name = 'coinbase';

  async fetchPrices(fiats: string[]): Promise<Record<string, string>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      let r: Response;
      try {
        r = await fetch(COINBASE_URL, { signal: ctrl.signal, redirect: 'error' });
      } catch (e: any) {
        throw new Error(`coinbase fetch error: ${sanitizeForLog(String(e?.message ?? e))}`);
      }

      if (!r.ok) {
        const retryAfter = r.headers?.get?.('retry-after');
        throw new Error(
          retryAfter
            ? `coinbase ${r.status} retry-after ${sanitizeForLog(String(retryAfter))}`
            : `coinbase ${r.status}`,
        );
      }

      let j: any;
      try {
        j = await r.json();
      } catch (e: any) {
        throw new Error(`coinbase fetch error: ${sanitizeForLog(String(e?.message ?? e))}`);
      }

      const currency = j?.data?.currency;
      if (currency !== 'USDC') {
        throw new Error(`coinbase base currency ${sanitizeForLog(String(currency))}`);
      }

      const rates = j?.data?.rates;
      if (!rates || typeof rates !== 'object') {
        throw new Error('coinbase response missing rates');
      }

      const result: Record<string, string> = {};
      for (const fiat of fiats) {
        const raw = rates[fiat.toUpperCase()];
        if (raw == null) {
          continue;
        }
        const isWellFormed = typeof raw === 'string' && COINBASE_DECIMAL_RATE_RE.test(raw);
        const price = isWellFormed ? Number(raw) : NaN;
        if (Number.isFinite(price) && price > 0) {
          result[fiat.toUpperCase()] = price.toFixed(6);
          continue;
        }
        const reason = isWellFormed ? 'implausible magnitude' : 'malformed format';
        console.error(
          `coinbase ignoring refused rate for ${fiat.toUpperCase()} (${reason}, typeof ${typeof raw}): ${sanitizeForLog(String(raw))}`,
        );
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
