import { Injectable } from '@nestjs/common';
import { PriceAdapter } from './price.types';
import { sanitizeForLog } from './log-sanitizer';

const FETCH_TIMEOUT_MS = 5_000;

function causeSuffixOf(e: any): string {
  const cause = e?.cause?.message ?? e?.cause;
  return cause ? ` (cause: ${sanitizeForLog(String(cause), 120)})` : '';
}

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
      try {
        r = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=${vsCurrencies}`,
          { signal: ctrl.signal, redirect: 'error' },
        );
      } catch (e: any) {
        throw new Error(
          `coingecko fetch error: ${sanitizeForLog(String(e?.message ?? e))}${causeSuffixOf(e)}`,
        );
      }
      try {
        bodyText = await r.text();
      } catch (e: any) {
        throw new Error(
          `coingecko ${r.status} fetch error: ${sanitizeForLog(String(e?.message ?? e))}${causeSuffixOf(e)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) {
      const retryAfter = r.headers.get('retry-after');
      throw new Error(
        retryAfter
          ? `coingecko ${r.status} (retry-after: ${sanitizeForLog(String(retryAfter))})`
          : `coingecko ${r.status}`,
      );
    }

    let j: { 'usd-coin'?: Record<string, number> };
    try {
      j = JSON.parse(bodyText) as { 'usd-coin'?: Record<string, number> };
    } catch {
      throw new Error(`coingecko invalid JSON: ${sanitizeForLog(JSON.stringify(bodyText.slice(0, 10)))}`);
    }
    const raw = j['usd-coin'] ?? {};

    const result: Record<string, string> = {};
    for (const fiat of fiats) {
      const price = raw[fiat.toLowerCase()];
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
        result[fiat.toUpperCase()] = String(price);
      }
    }
    return result;
  }
}
