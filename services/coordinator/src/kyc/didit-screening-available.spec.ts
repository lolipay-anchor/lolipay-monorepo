import { DiditKycProvider, DIDIT_WORKFLOWS_URL } from './didit-kyc-provider';
import { DiditRefusalsService } from '../monitoring/didit-refusals.service';
import { Logger } from '@nestjs/common';

const cfg = { diditApiKey: 'k', diditWorkflowId: 'wf-1', diditDailySessionBudget: 200 } as any;

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
  return new DiditKycProvider(cfg, new DiditRefusalsService(), fetcher);
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

  it('does not refuse to start when the bound workflow is not in the list', async () => {
    await expect(
      build({ status: 200, body: { results: [{ workflow_id: 'other', features: 'AML' }] } }).onModuleInit(),
    ).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/could not/i);
  });
});
