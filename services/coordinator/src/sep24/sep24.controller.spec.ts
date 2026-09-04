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
    const req: any = { headers: {}, cookies: {}, get: () => undefined };
    await controller.amount(req, 'tx-1', undefined as any, res);
    expect(sep24.submitAmount).toHaveBeenCalledWith('tx-1', expect.any(String), undefined, undefined);
  });
});
