import { Controller, HttpCode, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { DIDIT_FRESHNESS_SECS, verifyDiditDelivery } from './didit-signature';
import { readDiditDecision } from './didit-decision';
import { Sep12Service } from './sep12.service';
import { DiditRefusalsService } from '../monitoring/didit-refusals.service';

const NON_SESSION_EVENT_FAMILIES = ['user.', 'business.', 'activity.', 'transaction.', 'travel_rule.', 'workflow.'];
const ADVERSE_USER_STATUSES = ['FLAGGED', 'BLOCKED', 'IN_REVIEW'];

@Controller('webhooks')
export class DiditWebhookController {
  private readonly log = new Logger(DiditWebhookController.name);

  constructor(
    private cfg: AppConfigService,
    private sep12: Sep12Service,
    private refusals: DiditRefusalsService,
  ) {}

  @Post('didit')
  @HttpCode(200)
  async receive(@Req() req: any): Promise<void> {
    const raw = req.rawBody;
    const verdict = verifyDiditDelivery({
      raw,
      signature: String(req.headers['x-signature'] ?? ''),
      timestamp: String(req.headers['x-timestamp'] ?? ''),
      secret: this.cfg.diditWebhookSecret,
    });

    if (!verdict.trusted) {
      this.log.warn(`refused a delivery on /webhooks/didit: ${verdict.reason}`);
      this.refusals.couldNotAuthenticate(verdict.reason ?? 'unknown');
      throw new UnauthorizedException('this delivery was not signed by the shared secret');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      this.log.warn('a signed delivery on /webhooks/didit did not carry readable json');
      this.refusals.record('a signed delivery did not carry readable json');
      return;
    }
    const eventName = (payload as any)?.webhook_type;
    if (typeof eventName === 'string' && NON_SESSION_EVENT_FAMILIES.some((family) => eventName.startsWith(family))) {
      const status = String((payload as any)?.status ?? '').slice(0, 40);
      const line = `ignored a ${JSON.stringify(eventName.slice(0, 40))} delivery reporting ${JSON.stringify(status)}: it describes something other than a verification session`;
      if (ADVERSE_USER_STATUSES.includes(status)) this.log.warn(line);
      else this.log.log(line);
      return;
    }

    const sent = Number((payload as any)?.timestamp);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(sent) || Math.abs(now - sent) >= DIDIT_FRESHNESS_SECS) {
      this.log.warn('a signed delivery carried a time this anchor will not order by');
      this.refusals.record('a delivery carried a time this anchor will not order by');
      return;
    }

    const conclusion = readDiditDecision(payload, this.cfg.kycRequireAml);
    if (conclusion.unrecognisedStatus !== undefined) {
      this.log.warn(
        `a delivery reported a status this anchor does not recognise: ${JSON.stringify(
          conclusion.unrecognisedStatus.slice(0, 40),
        )}`,
      );
    }
    if ((payload as any)?.status === 'Approved' && conclusion.status !== 'ACCEPTED') {
      this.log.warn(`a delivery the vendor approved was not accepted by this anchor: ${conclusion.status}`);
    }
    await this.sep12.applyDelivery(conclusion, new Date(sent * 1000));
  }
}
