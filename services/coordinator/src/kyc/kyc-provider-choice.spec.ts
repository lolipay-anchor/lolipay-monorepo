import { chooseKycProvider } from './kyc.module';
import { DiditRefusalsService } from '../monitoring/didit-refusals.service';
import { DiditKycProvider } from './didit-kyc-provider';
import { StubKycProvider } from './stub-kyc-provider';

const counter = () => new DiditRefusalsService();

const cfg = (over: Record<string, string> = {}) =>
  ({ diditApiKey: 'k', diditWorkflowId: 'wf', ...over }) as any;

describe('which provider the anchor talks to is decided by configuration alone', () => {
  it('talks to the vendor when it has been told how', () => {
    expect(chooseKycProvider(cfg(), counter())).toBeInstanceOf(DiditKycProvider);
  });

  it.each([
    ['no key', { diditApiKey: '' }],
    ['no workflow', { diditWorkflowId: '' }],
  ])('falls back to the stub when there is %s, rather than half configuring itself', (_n, over) => {
    expect(chooseKycProvider(cfg(over), counter())).toBeInstanceOf(StubKycProvider);
  });
});
