import { readFileSync } from 'fs';
import { join } from 'path';
import { AppConfigService } from './app-config.service';
import { spreadCoversPriceDeviation, platformFeeFitsSpread } from './rate-guard';

describe('spreadCoversPriceDeviation', () => {
  it('accepts a spread strictly wider than the deviation allowance', () => {
    expect(spreadCoversPriceDeviation(150, 100)).toBeNull();
  });

  it('refuses a spread equal to the deviation allowance', () => {
    expect(spreadCoversPriceDeviation(100, 100)).not.toBeNull();
  });

  it('refuses a spread narrower than the deviation allowance', () => {
    expect(spreadCoversPriceDeviation(50, 100)).not.toBeNull();
  });

  it('refuses a zero spread even when the deviation allowance is zero', () => {
    expect(spreadCoversPriceDeviation(0, 0)).not.toBeNull();
  });

  it('accepts a one-basis-point cushion', () => {
    expect(spreadCoversPriceDeviation(101, 100)).toBeNull();
  });

  it('names both numbers and the invariant so an operator knows which to change', () => {
    const problem = spreadCoversPriceDeviation(50, 100) as string;
    expect(problem).toContain('50');
    expect(problem).toContain('100');
    expect(problem).toContain('INV-30.1');
  });
});

describe('the shipped defaults satisfy INV-30.1', () => {
  function schemaDefaultSpreadBps(): number {
    const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const model = schema.match(/model Config \{[\s\S]*?\n\}/)?.[0];
    expect(model).toBeDefined();
    const found = (model as string).match(/spreadBps\s+Int\s+@default\((\d+)\)/);
    expect(found).not.toBeNull();
    return Number((found as RegExpMatchArray)[1]);
  }

  function envExampleDeviationBps(): number {
    const env = readFileSync(join(__dirname, '../../.env.example'), 'utf8');
    const found = env.match(/^PRICE_DEVIATION_MAX_BPS=(\d+)/m);
    expect(found).not.toBeNull();
    return Number((found as RegExpMatchArray)[1]);
  }

  it('finds a spreadBps default in the Prisma schema to compare against', () => {
    expect(schemaDefaultSpreadBps()).toBeGreaterThan(0);
  });

  it('keeps the built-in deviation default strictly below the schema spread default', () => {
    const cfg = new AppConfigService({ get: () => undefined } as any);
    expect(spreadCoversPriceDeviation(schemaDefaultSpreadBps(), cfg.priceDeviationMaxBps)).toBeNull();
  });

  it('keeps the .env.example deviation value strictly below the schema spread default', () => {
    expect(spreadCoversPriceDeviation(schemaDefaultSpreadBps(), envExampleDeviationBps())).toBeNull();
  });

  it('keeps .env.example and the built-in default in agreement', () => {
    const cfg = new AppConfigService({ get: () => undefined } as any);
    expect(envExampleDeviationBps()).toBe(cfg.priceDeviationMaxBps);
  });
});

describe('platformFeeFitsSpread: on a withdrawal the provider keeps spread minus platform fee minus whatever price move the deviation band accepts', () => {
  it('accepts the live pair, 30 bps fee against a 150 bps spread with a 100 bps deviation band, which leaves 20 bps', () => {
    expect(platformFeeFitsSpread(30, 150, 100)).toBeNull();
  });

  it('refuses a fee equal to the spread, which would leave the provider exactly nothing before any price move', () => {
    expect(platformFeeFitsSpread(150, 150, 100)).toMatch(/platformFeeBps/);
  });

  it('refuses a fee that fits under the spread but not under the spread less the deviation band, because one accepted anomaly then costs the provider money while the record says fee zero', () => {
    expect(platformFeeFitsSpread(60, 150, 100)).toMatch(/priceDeviationMaxBps|deviation/i);
    expect(platformFeeFitsSpread(50, 150, 100)).toMatch(/deviation/i);
  });

  it('accepts a fee that leaves at least one basis point after the deviation band', () => {
    expect(platformFeeFitsSpread(49, 150, 100)).toBeNull();
  });
});

describe('the shipped defaults also leave the provider something after the deviation band', () => {
  it('schema platformFeeBps and spreadBps against .env.example PRICE_DEVIATION_MAX_BPS', () => {
    const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const model = schema.match(/model Config \{[\s\S]*?\n\}/)?.[0] as string;
    const spread = Number(model.match(/spreadBps\s+Int\s+@default\((\d+)\)/)![1]);
    const fee = Number(model.match(/platformFeeBps\s+Int\s+@default\((\d+)\)/)![1]);
    const env = readFileSync(join(__dirname, '../../.env.example'), 'utf8');
    const deviation = Number(env.match(/^PRICE_DEVIATION_MAX_BPS=(\d+)/m)![1]);
    expect(platformFeeFitsSpread(fee, spread, deviation)).toBeNull();
    expect(platformFeeFitsSpread(spread - deviation, spread, deviation)).not.toBeNull();
  });
});
