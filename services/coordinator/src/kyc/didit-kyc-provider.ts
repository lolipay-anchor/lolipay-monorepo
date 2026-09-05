import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { DiditRefusalsService } from '../monitoring/didit-refusals.service';
import { KycDecision, KycProvider } from './kyc-provider';

export const DIDIT_SESSION_URL = 'https://verification.didit.me/v3/session/';
export const DIDIT_WORKFLOWS_URL = 'https://verification.didit.me/v3/workflows/';
export const DIDIT_TIMEOUT_MS = 10_000;
export const DIDIT_BOOT_PROBE_MS = 5_000;

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

  async onModuleInit(): Promise<void> {
    const log = new Logger('Kyc');
    let features: string | undefined;
    try {
      const res = await this.fetcher(DIDIT_WORKFLOWS_URL, {
        headers: { 'x-api-key': this.cfg.diditApiKey },
        signal: AbortSignal.timeout(DIDIT_BOOT_PROBE_MS),
      });
      if (res.ok) {
        const body: any = await res.json();
        const rows = Array.isArray(body) ? body : (body?.results ?? []);
        features = rows.find((w: any) => w?.workflow_id === this.cfg.diditWorkflowId)?.features;
      }
    } catch {
      features = undefined;
    }

    if (typeof features !== 'string') {
      log.warn(
        'could not read which checks the configured verification workflow performs, so whether this deployment can screen is unknown; starting anyway',
      );
      return;
    }
    this.refusals.workflowPerformsAml(/\bAML\b/i.test(features));
    if (!/\bAML\b/i.test(features)) {
      if (this.cfg.kycRequireAml) {
        log.warn(
          `this deployment CANNOT SCREEN: the configured workflow performs ${features}, with no AML step, so no customer will ever be screened and every deposit will refuse; set KYC_REQUIRE_AML=false to accept identity checks alone`,
        );
      } else {
        log.log(`the configured verification workflow performs ${features}; AML is not required (KYC_REQUIRE_AML=false), so an accepted identity alone may move funds`);
      }
      return;
    }
    if (!this.cfg.kycRequireAml) {
      log.warn(
        `the configured verification workflow performs ${features}, but AML is not required (KYC_REQUIRE_AML=false), so a delivery that carries no screening still opens the gate — a vendor payload that dropped aml_screenings would not be noticed here`,
      );
      return;
    }
    log.log(`the configured verification workflow performs ${features}`);
  }

  async start(customerRef: string, _fields: Record<string, string>): Promise<KycDecision> {
    const apiKey = this.cfg.diditApiKey;
    const workflowId = this.cfg.diditWorkflowId;
    if (!apiKey || !workflowId) {
      this.refuse('identity verification is not configured');
    }

    if (!this.overBudget()) this.refusals.spendResumed();
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
    return {
      status: 'PROCESSING',
      providerRef: String(session.session_id),
      verificationUrl: String(session.url),
    };
  }
}
