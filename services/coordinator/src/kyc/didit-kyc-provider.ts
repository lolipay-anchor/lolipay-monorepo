import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { DiditRefusalsService } from '../monitoring/didit-refusals.service';
import { KycDecision, KycProvider } from './kyc-provider';

export const DIDIT_SESSION_URL = 'https://verification.didit.me/v3/session/';
export const DIDIT_TIMEOUT_MS = 10_000;

type Fetcher = (url: string, init: any) => Promise<any>;

@Injectable()
export class DiditKycProvider implements KycProvider {
  constructor(
    private cfg: AppConfigService,
    private refusals: DiditRefusalsService,
    private fetcher: Fetcher = fetch,
  ) {}

  private started: number[] = [];

  private overBudget(): boolean {
    const cutoff = Date.now() - 86_400_000;
    this.started = this.started.filter((t) => t > cutoff);
    return this.started.length >= this.cfg.diditDailySessionBudget;
  }

  private refuse(reason: string): never {
    this.refusals.providerFailed(reason);
    throw new ServiceUnavailableException(reason);
  }

  async start(customerRef: string, _fields: Record<string, string>): Promise<KycDecision> {
    const apiKey = this.cfg.diditApiKey;
    const workflowId = this.cfg.diditWorkflowId;
    if (!apiKey || !workflowId) {
      this.refuse('identity verification is not configured');
    }

    if (this.overBudget()) {
      const reason = `this anchor has already opened ${this.started.length} verifications in the last day, which is its whole budget`;
      this.refusals.budgetExhausted(reason);
      throw new ServiceUnavailableException(reason);
    }

    const reserved = Date.now();
    this.started.push(reserved);
    try {
      return await this.open(customerRef);
    } catch (e) {
      const held = this.started.lastIndexOf(reserved);
      if (held >= 0) this.started.splice(held, 1);
      throw e;
    }
  }

  private async open(customerRef: string): Promise<KycDecision> {
    const apiKey = this.cfg.diditApiKey;
    const workflowId = this.cfg.diditWorkflowId;
    const res = await this.fetcher(DIDIT_SESSION_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_id: workflowId, vendor_data: customerRef }),
      signal: AbortSignal.timeout(DIDIT_TIMEOUT_MS),
    });

    if (!res.ok) {
      await res.text?.().catch(() => undefined);
      this.refuse('identity verification could not be started');
    }

    const session = await res.json();
    if (!session?.session_id || !session?.url) {
      this.refuse('identity verification returned no session');
    }

    this.refusals.providerAnswered();
    this.refusals.spendResumed();
    return {
      status: 'PROCESSING',
      providerRef: String(session.session_id),
      verificationUrl: String(session.url),
    };
  }
}
