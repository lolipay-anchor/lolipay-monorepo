import { Sep24Controller } from './sep24.controller';

describe('the interactive routes survive a request whose body no parser produced', () => {
  function build() {
    const sep24 = { submitAmount: jest.fn(async () => undefined), openInteractive: jest.fn(async () => ({ id: 'tx-1', url: 'u' })) } as any;
    const cfg = {
      anchorBaseUrl: 'https://api.lolipay.app',
      jwtSecret: ['unit', 'test', 'key', '0123456789'].join('-'),
      jwtIssuer: 'https://lolipay.app',
      jwtAudience: 'lolipay-app',
    } as any;
    const controller = new Sep24Controller(sep24, {} as any, cfg);
    const res: any = { redirect: jest.fn() };
    return { controller, sep24, res };
  }

  it('hands an absent body to the amount step as absent fields, instead of throwing before any check runs', async () => {
    const { controller, sep24, res } = build();
    const req: any = { headers: {} };
    await controller.amount(req, 'tx-1', undefined as any, res);
    expect(sep24.submitAmount).toHaveBeenCalledWith('tx-1', '', undefined, undefined);
    expect(res.redirect).toHaveBeenCalledWith(302, '/sep24/interactive/tx-1');
  });
});

describe('the identity route bounds every field length before any of it reaches the vendor', () => {
  function build() {
    const sep24 = { submitIdentity: jest.fn(async () => undefined) } as any;
    const cfg = {
      anchorBaseUrl: 'https://api.lolipay.app',
      jwtSecret: ['unit', 'test', 'key', '0123456789'].join('-'),
      jwtIssuer: 'https://lolipay.app',
      jwtAudience: 'lolipay-app',
    } as any;
    const controller = new Sep24Controller(sep24, {} as any, cfg);
    const res: any = { redirect: jest.fn() };
    return { controller, sep24, res };
  }

  it('drops a first_name over 255 characters rather than forwarding it', async () => {
    const { controller, sep24, res } = build();
    const req: any = { headers: {} };
    await controller.identity(req, 'tx-1', { first_name: 'a'.repeat(256) }, res);
    expect(sep24.submitIdentity).toHaveBeenCalledWith('tx-1', '', {});
  });

  it('keeps a first_name at exactly 255 characters', async () => {
    const { controller, sep24, res } = build();
    const req: any = { headers: {} };
    const atBound = 'a'.repeat(255);
    await controller.identity(req, 'tx-1', { first_name: atBound }, res);
    expect(sep24.submitIdentity).toHaveBeenCalledWith('tx-1', '', { first_name: atBound });
  });
});
