import { ServiceUnavailableException } from '@nestjs/common';
import { DiditKycProvider } from './didit-kyc-provider';

const REF = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const fields = {
  first_name: 'Budi',
  last_name: 'Santoso',
  email_address: 'budi@example.com',
  id_type: 'id_card',
  id_country_code: 'IDN',
};

function provider(reply: { status: number; body: unknown }, cfg: Record<string, string> = {}) {
  const fetcher = jest.fn(async () => ({
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    json: async () => reply.body,
    text: async () => JSON.stringify(reply.body),
  })) as any;
  const config = {
    diditApiKey: 'example-api-key-not-a-real-one',
    diditWorkflowId: 'wf-1',
    ...cfg,
  } as any;
  return { p: new DiditKycProvider(config, fetcher), fetcher };
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

  it('never puts the key in the message a caller might see', async () => {
    const { p } = provider({ status: 403, body: { detail: 'nope' } }, {});
    await expect(p.start(REF, fields)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('example-api-key') }),
    );
  });
});
