export function applyBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10_000n;
}

const USDC_BASE_UNITS = 10_000_000n;

export function baseUnitsToUsdc(base: bigint): number {
  const whole = base / USDC_BASE_UNITS;
  const frac = base % USDC_BASE_UNITS;
  return Number(whole) + Number(frac) / 1e7;
}

export function baseUnitsToUsdcString(base: bigint): string {
  const negative = base < 0n;
  const magnitude = negative ? -base : base;
  const whole = magnitude / USDC_BASE_UNITS;
  const frac = magnitude % USDC_BASE_UNITS;
  return `${negative ? '-' : ''}${whole}.${frac.toString().padStart(7, '0')}`;
}

export function splitFees(usdc: bigint, platformBps: number, lpBps: number) {
  const platformFee = applyBps(usdc, platformBps);
  const lpFee = applyBps(usdc, lpBps);
  const net = usdc - platformFee - lpFee;
  return { platformFee, lpFee, net };
}

export function applySpreadToRate(midPrice: string, spreadBps: number): string {
  const parsed = parseFloat(midPrice);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(`Invalid midPrice: "${midPrice}"`);
  }

  const priceMicro = BigInt(Math.round(parsed * 1_000_000));
  const withSpread = priceMicro + (priceMicro * BigInt(spreadBps)) / 10_000n;
  const whole = withSpread / 1_000_000n;
  const frac = withSpread % 1_000_000n;
  if (frac === 0n) return whole.toString();

  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

export function quoteFiat(
  usdcBaseUnits: bigint,
  idrPerUsdc: string,
  spreadBps: number,
  sell = false,
): bigint {
  const parsed = parseFloat(idrPerUsdc);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(`Invalid idrPerUsdc: "${idrPerUsdc}"`);
  }

  const priceMicro = BigInt(Math.round(parsed * 1_000_000));
  const spreadMicro = (priceMicro * BigInt(spreadBps)) / 10_000n;
  const withSpread = sell ? priceMicro - spreadMicro : priceMicro + spreadMicro;

  return (usdcBaseUnits * withSpread) / 10_000_000n / 1_000_000n;
}

export function quoteUsdcForFiat(
  fiatAmount: bigint,
  idrPerUsdc: string,
  spreadBps: number,
  sell = false,
): bigint {
  const parsed = parseFloat(idrPerUsdc);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(`Invalid idrPerUsdc: "${idrPerUsdc}"`);
  }
  if (fiatAmount <= 0n) throw new RangeError('fiatAmount must be positive');
  const priceMicro = BigInt(Math.round(parsed * 1_000_000));
  const spreadMicro = (priceMicro * BigInt(spreadBps)) / 10_000n;
  const withSpread = sell ? priceMicro - spreadMicro : priceMicro + spreadMicro;
  if (withSpread <= 0n) throw new RangeError('spread too large');

  const numerator = fiatAmount * 10_000_000n * 1_000_000n;
  return (numerator + withSpread - 1n) / withSpread;
}

export const FIAT_INPUT_REFUSAL =
  'write the amount in plain digits, for example 200000, or with dots as thousands separators, for example 200.000: commas, fractions and other symbols are refused because they could mean two different amounts, and this anchor will not guess which';

const FIAT_INPUT_RE = /^(Rp\.?\s*)?(\d+|[1-9]\d{0,2}(\.\d{3})+)$/i;

export function fiatInputAccepted(raw: string): boolean {
  return FIAT_INPUT_RE.test(raw.trim());
}

export function fiatDigits(raw: unknown): string {
  return String(raw).replace(/[^0-9]/g, '');
}
