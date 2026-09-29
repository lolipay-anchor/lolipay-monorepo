import { Injectable } from '@nestjs/common';
import { PriceAdapter } from './price.types';

const FETCH_TIMEOUT_MS = 5_000;

@Injectable()
export class CoinGeckoAdapter implements PriceAdapter {
  name = 'coingecko';

  async fetchPrices(fiats: string[]): Promise<Record<string, string>> {
    const vsCurrencies = fiats.map((f) => f.toLowerCase()).join(',');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let r: Response;
    let bodyText: string;
    try {
      r = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=${vsCurrencies}`,
        { signal: ctrl.signal },
      );
      bodyText = await r.text();
    } catch (e: any) {
      throw new Error(`coingecko fetch error: ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) throw new Error(`coingecko ${r.status}`);

    let j: { 'usd-coin'?: Record<string, number> };
    try {
      j = JSON.parse(bodyText) as { 'usd-coin'?: Record<string, number> };
    } catch {
      throw new Error(`coingecko invalid JSON: ${JSON.stringify(bodyText.slice(0, 10))}`);
    }
    const raw = j['usd-coin'] ?? {};

    const result: Record<string, string> = {};
    for (const fiat of fiats) {
      const price = raw[fiat.toLowerCase()];
      if (price != null && price > 0) {
        result[fiat.toUpperCase()] = String(price);
      }
    }
    return result;
  }
}
