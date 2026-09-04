import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { DiditRefusalsService } from '../monitoring/didit-refusals.service';
import { DiditKycProvider } from './didit-kyc-provider';

const REF = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const fields = {
  first_name: 'Budi',
  last_name: 'Santoso',
  email_address: 'budi@example.com',
  id_type: 'id_card',
  id_country_code: 'IDN',
};

function provider(reply: { status: number; body: unknown }, cfg: Record<string, unknown> = {}) {
  const fetcher = jest.fn(async () => ({
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    json: async () => reply.body,
    text: async () => JSON.stringify(reply.body),
  })) as any;
  const config = {
    diditApiKey: 'example-api-key-not-a-real-one',
    diditWorkflowId: 'wf-1',
    diditDailySessionBudget: 200,
    kycRequireAml: true,
    ...cfg,
  } as any;
  const refusals = new DiditRefusalsService();
  return { p: new DiditKycProvider(config, refusals, fetcher), fetcher, refusals };
}

const created = { session_id: 'sess-1', url: 'https://verify.didit.me/session/abc', status: 'Not Started' };

describe('opening a verification a customer can actually complete', () => {
  it('reports the session as in flight, never as screened or accepted', async () => {
    const { p } = provider({ status: 201, body: created });
    expect(await p.start(REF, fields)).toEqual({
      status: 'PROCESSING',
      providerRef: 'sess-1',
      verificationUrl: 'https://verify.didit.me/session/abc',
    });
  });

  it('names the customer to the provider, so the delivery can be matched back', async () => {
    const { p, fetcher } = provider({ status: 201, body: created });
    await p.start(REF, fields);
    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ workflow_id: 'wf-1', vendor_data: REF });
  });

  it('sends the key in the header the provider expects, and never in the body', async () => {
    const { p, fetcher } = provider({ status: 201, body: created });
    await p.start(REF, fields);
    const [, init] = fetcher.mock.calls[0];
    expect(init.headers['x-api-key']).toBe('example-api-key-not-a-real-one');
    expect(init.body).not.toContain('example-api-key');
  });

  it('never forwards what the customer typed, because the provider collects it itself', async () => {
    const { p, fetcher } = provider({ status: 201, body: created });
    await p.start(REF, fields);
    const [, init] = fetcher.mock.calls[0];
    for (const value of Object.values(fields)) expect(init.body).not.toContain(value);
  });

  it.each([
    ['the key is refused', 403],
    ['the workflow is not published', 400],
    ['the provider is unwell', 502],
  ])('refuses to invent a session when %s', async (_n, status) => {
    const { p } = provider({ status, body: { detail: 'nope' } });
    await expect(p.start(REF, fields)).rejects.toThrow(ServiceUnavailableException);
  });

  it('refuses when the provider answers without a session to point the customer at', async () => {
    const { p } = provider({ status: 201, body: { session_id: 'sess-1' } });
    await expect(p.start(REF, fields)).rejects.toThrow(ServiceUnavailableException);
  });

  it.each([
    ['no key is configured', { diditApiKey: '' }],
    ['no workflow is configured', { diditWorkflowId: '' }],
  ])('refuses before calling anybody when %s', async (_n, cfg) => {
    const { p, fetcher } = provider({ status: 201, body: created }, cfg);
    await expect(p.start(REF, fields)).rejects.toThrow(ServiceUnavailableException);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops buying once the day s whole budget is spent, rather than emptying the account', async () => {
    const { p, fetcher, refusals } = provider({ status: 201, body: created }, { diditDailySessionBudget: 2 });
    await p.start(REF, fields);
    await p.start(REF, fields);
    await expect(p.start(REF, fields)).rejects.toThrow(/budget/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(refusals.state().overBudget).toBe(1);
    expect(refusals.state().providerFailures).toBe(0);
  });

  it('refuses a session the provider answered with an error status, however well formed the body', async () => {
    const { p } = provider({
      status: 403,
      body: { session_id: 'sess-1', url: 'https://verify.didit.me/u/sess-1' },
    });
    await expect(p.start(REF, fields)).rejects.toThrow(ServiceUnavailableException);
  });

  it('records a provider that would not answer, so an outage is not only the customer s problem', async () => {
    const { p, refusals } = provider({ status: 502, body: { detail: 'nope' } });
    await expect(p.start(REF, fields)).rejects.toThrow();
    expect(refusals.state().providerFailures).toBe(1);
    expect(String(refusals.state().providerReason)).toContain('verification');
  });

  it('records a session it could not open even before calling anybody', async () => {
    const { p, refusals } = provider({ status: 201, body: created }, { diditApiKey: '' });
    await expect(p.start(REF, fields)).rejects.toThrow();
    expect(refusals.state().providerFailures).toBe(1);
  });

  it('never puts the key in the message a caller might see', async () => {
    const { p } = provider({ status: 403, body: { detail: 'nope' } }, {});
    await expect(p.start(REF, fields)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('example-api-key') }),
    );
  });
});

describe('a budget slot is held while the money is being spent', () => {
  it('gives the slot back when the provider refuses, so an outage does not eat the day', async () => {
    const { p, fetcher } = provider({ status: 502, body: { detail: 'nope' } }, {
      diditDailySessionBudget: 2,
    });
    await expect(p.start(REF, fields)).rejects.toThrow();
    await expect(p.start(REF, fields)).rejects.toThrow();
    await expect(p.start(REF, fields)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('counts a slot the moment it is taken, so requests in flight together cannot overspend', async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => (release = r));
    const fetcher = jest.fn(async () => {
      await gate;
      return {
        ok: true,
        status: 201,
        json: async () => created,
        text: async () => '',
      };
    }) as any;
    const refusals = new DiditRefusalsService();
    const p = new DiditKycProvider(
      { diditApiKey: 'k', diditWorkflowId: 'wf', diditDailySessionBudget: 1 } as any,
      refusals,
      fetcher,
    );
    const first = p.start(REF, fields);
    await expect(p.start('GOTHER', fields)).rejects.toThrow(/budget/);
    release(null);
    await first;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('what boot says about a workflow with no AML step depends on whether AML is required', () => {
  const workflows = { status: 200, body: [{ workflow_id: 'wf-1', features: 'OCR + LIVENESS + FACE_MATCH + IP_ANALYSIS' }] };

  it('warns that the deployment cannot screen when AML is required', async () => {
    const { p } = provider(workflows, { kycRequireAml: true });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await p.onModuleInit();
      expect(warn.mock.calls.map((c) => String(c[0])).join(' ')).toMatch(/CANNOT SCREEN/);
      expect(log.mock.calls.map((c) => String(c[0])).join(' ')).not.toMatch(/AML is not required/);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('says identity alone may move funds when AML is not required, and does not call that a failure', async () => {
    const { p } = provider(workflows, { kycRequireAml: false });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await p.onModuleInit();
      expect(warn.mock.calls.map((c) => String(c[0])).join(' ')).not.toMatch(/CANNOT SCREEN/);
      expect(log.mock.calls.map((c) => String(c[0])).join(' ')).toMatch(/AML is not required \(KYC_REQUIRE_AML=false\)/);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('warns when the workflow does perform AML but AML is not required, because a delivery with no screening would then open the gate unnoticed', async () => {
    const withAml = { status: 200, body: [{ workflow_id: 'wf-1', features: 'OCR + LIVENESS + FACE_MATCH + AML + IP_ANALYSIS' }] };
    const { p } = provider(withAml, { kycRequireAml: false });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await p.onModuleInit();
      expect(warn.mock.calls.map((c) => String(c[0])).join(' ')).toMatch(/no screening still opens the gate/);
    } finally {
      warn.mockRestore();
    }
  });
});
