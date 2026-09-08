import { DiditKycProvider, DIDIT_WORKFLOWS_URL, DIDIT_WORKFLOW_RETRY_MS } from './didit-kyc-provider';
import { DiditRefusalsService } from '../monitoring/didit-refusals.service';
import { Logger } from '@nestjs/common';

const cfg = { diditApiKey: 'k', diditWorkflowId: 'wf-1', diditDailySessionBudget: 200, kycRequireAml: true } as any;

function buildWith(replies: Array<{ status: number; body: unknown } | Error>) {
  let calls = 0;
  const fetcher = jest.fn(async (url: string) => {
    const reply = replies[Math.min(calls, replies.length - 1)];
    calls += 1;
    if (reply instanceof Error) throw reply;
    if (!String(url).startsWith(DIDIT_WORKFLOWS_URL)) throw new Error('unexpected url ' + url);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body),
    };
  }) as any;
  const refusals = new DiditRefusalsService();
  return { provider: new DiditKycProvider(cfg, refusals, fetcher), refusals, fetcher };
}

const built: DiditKycProvider[] = [];

function build(reply: { status: number; body: unknown } | Error) {
  const fetcher = jest.fn(async (url: string) => {
    if (reply instanceof Error) throw reply;
    if (!String(url).startsWith(DIDIT_WORKFLOWS_URL)) throw new Error('unexpected url ' + url);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body),
    };
  }) as any;
  const provider = new DiditKycProvider(cfg, new DiditRefusalsService(), fetcher);
  built.push(provider);
  return provider;
}

const workflows = (features: string) => ({
  results: [{ workflow_id: 'wf-1', workflow_label: 'bound', features }],
});

describe('the anchor says at boot whether the workflow it is bound to can screen', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
    built.splice(0).forEach((p) => p.onModuleDestroy());
  });

  it('warns loudly when the bound workflow carries no AML step', async () => {
    await build({ status: 200, body: workflows('OCR + LIVENESS + FACE_MATCH + IP_ANALYSIS') }).onModuleInit();
    const said = warn.mock.calls.flat().join(' ');
    expect(said).toMatch(/cannot screen/i);
    expect(said).toMatch(/deposit/i);
  });

  it('says so plainly when the workflow can screen, so the log records which it was', async () => {
    await build({ status: 200, body: workflows('OCR + LIVENESS + FACE_MATCH + AML + IP_ANALYSIS') }).onModuleInit();
    expect(warn).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toMatch(/AML/);
  });

  it('does not refuse to start when the workflow cannot be read, because a vendor outage is not a misconfiguration', async () => {
    await expect(build(new Error('network is down')).onModuleInit()).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/could not/i);
  });

  it('does not refuse to start when the bound workflow is not in the list, names the id as the thing to check, and does not ask again', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.useFakeTimers();
    try {
      const { provider, fetcher } = buildWith([{ status: 200, body: { results: [{ workflow_id: 'other', features: 'AML' }] } }]);
      await expect(provider.onModuleInit()).resolves.toBeUndefined();
      expect(error.mock.calls.flat().join(' ')).toMatch(/DIDIT_WORKFLOW_ID/);
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(/could not/i);
      await jest.advanceTimersByTimeAsync(DIDIT_WORKFLOW_RETRY_MS * 3);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      error.mockRestore();
    }
  });

  it('asks the vendor again once a minute, not once a second or once an hour', () => {
    expect(DIDIT_WORKFLOW_RETRY_MS).toBe(60_000);
  });

  it('keeps asking the vendor once a minute after a failed boot read, and stops the moment it knows', async () => {
    jest.useFakeTimers();
    try {
      const { provider, refusals, fetcher } = buildWith([
        new Error('network is down'),
        { status: 200, body: workflows('OCR + LIVENESS + FACE_MATCH + AML + IP_ANALYSIS') },
      ]);
      await provider.onModuleInit();
      expect(refusals.state().performsAml).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(DIDIT_WORKFLOW_RETRY_MS);
      expect(refusals.state().performsAml).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(DIDIT_WORKFLOW_RETRY_MS * 3);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['an empty object', {}],
    ['a list under a name this code does not know', { data: [{ workflow_id: 'wf-1', features: 'AML' }] }],
    ['a string where a body was expected', 'maintenance'],
  ])('keeps asking when the vendor answers with %s, because no list was read and nothing was learned', async (_label, body) => {
    jest.useFakeTimers();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { provider, refusals, fetcher } = buildWith([
        { status: 200, body },
        { status: 200, body: workflows('OCR + LIVENESS + FACE_MATCH + AML + IP_ANALYSIS') },
      ]);
      await provider.onModuleInit();
      expect(refusals.state().performsAml).toBeUndefined();
      expect(error).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(DIDIT_WORKFLOW_RETRY_MS);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(refusals.state().performsAml).toBe(true);
    } finally {
      jest.useRealTimers();
      error.mockRestore();
    }
  });

  it('stops asking when the module is torn down, so a test or a shutdown never leaves a timer behind', async () => {
    jest.useFakeTimers();
    try {
      const { provider, fetcher } = buildWith([new Error('network is down')]);
      await provider.onModuleInit();
      provider.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(DIDIT_WORKFLOW_RETRY_MS * 2);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
