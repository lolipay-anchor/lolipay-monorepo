import { readFileSync } from 'fs';
import { join } from 'path';
import { AppConfigService } from './app-config.service';
import { spreadCoversPriceDeviation } from './rate-guard';

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
