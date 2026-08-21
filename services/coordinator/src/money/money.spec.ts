import { applyBps, splitFees, quoteFiat, quoteUsdcForFiat, baseUnitsToUsdc } from './money';
describe('money', () => {
  it('applyBps: 0.30% of 100 USDC', () => {
    expect(applyBps(1_000_000_000n, 30)).toBe(3_000_000n);
  });
  it('splitFees invariant sums to amount', () => {
    const { platformFee, lpFee, net } = splitFees(1_000_000_000n, 30, 120);
    expect(platformFee).toBe(3_000_000n);
    expect(lpFee).toBe(12_000_000n);
    expect(net).toBe(985_000_000n);
    expect(platformFee + lpFee + net).toBe(1_000_000_000n);
  });
  it('quoteFiat: 100 USDC at 16000 IDR/USDC + 1.5% spread', () => {
    expect(quoteFiat(1_000_000_000n, '16000', 150)).toBe(1_624_000n);
  });
  it('quoteFiat: throws RangeError on non-numeric price', () => {
    expect(() => quoteFiat(1_000_000_000n, 'N/A', 150)).toThrow(RangeError);
  });

  it('quoteUsdcForFiat (sell): a QRIS bill maps to enough USDC to cover it', () => {
    const usdc = quoteUsdcForFiat(157_600n, '16000', 150, true);
    expect(usdc).toBe(100_000_000n);

    expect(quoteFiat(usdc, '16000', 150, true)).toBeGreaterThanOrEqual(157_600n);
  });

  it('quoteUsdcForFiat: rounds UP so the locked USDC never underfunds the bill', () => {
    const bill = 100_000n;
    const usdc = quoteUsdcForFiat(bill, '16000', 150, true);
    expect(quoteFiat(usdc, '16000', 150, true)).toBeGreaterThanOrEqual(bill);
  });

  it('quoteUsdcForFiat: rejects non-positive fiat and bad price', () => {
    expect(() => quoteUsdcForFiat(0n, '16000', 150, true)).toThrow(RangeError);
    expect(() => quoteUsdcForFiat(1000n, 'N/A', 150, true)).toThrow(RangeError);
  });

  describe('baseUnitsToUsdc', () => {
    it('converts an exact whole-USDC amount', () => {
      expect(baseUnitsToUsdc(100_0000000n)).toBe(100);
    });
    it('converts a fractional base-unit amount', () => {
      expect(baseUnitsToUsdc(1_500_0000n)).toBeCloseTo(1.5, 7);
      expect(baseUnitsToUsdc(1_2345678n)).toBeCloseTo(1.2345678, 7);
    });
    it('converts zero', () => {
      expect(baseUnitsToUsdc(0n)).toBe(0);
    });
  });
});
