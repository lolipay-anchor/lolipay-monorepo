import { Injectable } from '@nestjs/common';
import { PriceAdapter } from './price.types';

const FETCH_TIMEOUT_MS = 5_000;
const COINBASE_URL = 'https://api.coinbase.com/v2/exchange-rates?currency=USDC';

function sanitize(message: string): string {
  return message.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

@Injectable()
export class CoinbaseAdapter implements PriceAdapter {
  name = 'coinbase';

  async fetchPrices(fiats: string[]): Promise<Record<string, string>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      let r: Response;
      try {
        r = await fetch(COINBASE_URL, { signal: ctrl.signal });
      } catch (e: any) {
        throw new Error(`coinbase fetch error: ${sanitize(String(e?.message ?? e))}`);
      }

      if (!r.ok) {
        const retryAfter = r.headers?.get?.('retry-after');
        throw new Error(
          retryAfter ? `coinbase ${r.status} retry-after ${retryAfter}` : `coinbase ${r.status}`,
        );
      }

      let j: any;
      try {
        j = await r.json();
      } catch (e: any) {
        throw new Error(`coinbase fetch error: ${sanitize(String(e?.message ?? e))}`);
      }

      const currency = j?.data?.currency;
      if (currency !== 'USDC') {
        throw new Error(`coinbase base currency ${sanitize(String(currency))}`);
      }

      const rates = j?.data?.rates;
      if (!rates || typeof rates !== 'object') {
        throw new Error('coinbase response missing rates');
      }

      const result: Record<string, string> = {};
      for (const fiat of fiats) {
        const raw = rates[fiat.toUpperCase()];
        const price = raw == null ? NaN : Number(raw);
        if (Number.isFinite(price) && price > 0) {
          result[fiat.toUpperCase()] = price.toFixed(6);
        }
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
