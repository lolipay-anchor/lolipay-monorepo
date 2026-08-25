import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { AlertsService } from './alerts.service';

describe('the environment template offers every variable the monitor needs', () => {
  const env = readFileSync(join(__dirname, '../../.env.example'), 'utf8');

  it('offers ALERT_WEBHOOK_URL, without which every alert is built and discarded', () => {
    expect(env).toMatch(/^ALERT_WEBHOOK_URL=/m);
  });

  it('offers HEARTBEAT_STALE_SECONDS, which the matching guard reads', () => {
    expect(env).toMatch(/^HEARTBEAT_STALE_SECONDS=/m);
  });
});

describe('the alerts service tells an operator when alerts go nowhere', () => {
  function makeSvc(alertWebhookUrl: string | undefined) {
    return new AlertsService({} as any, { alertWebhookUrl } as any, { register: jest.fn() } as any);
  }

  it('says so at boot when the webhook is unset', () => {
    const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    makeSvc(undefined).onModuleInit();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('ALERT_WEBHOOK_URL'));
    err.mockRestore();
  });

  it('stays quiet when the webhook is configured', () => {
    const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    makeSvc('https://hooks.example/x').onModuleInit();
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
