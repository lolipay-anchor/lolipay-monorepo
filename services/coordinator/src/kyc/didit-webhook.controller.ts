import { Controller, HttpCode, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { DIDIT_FRESHNESS_SECS, verifyDiditDelivery } from './didit-signature';
import { readDiditDecision } from './didit-decision';
import { Sep12Service } from './sep12.service';
import { DiditRefusalsService } from '../monitoring/didit-refusals.service';

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
      this.refusals.record(verdict.reason ?? 'unknown');
      throw new UnauthorizedException('this delivery was not signed by the shared secret');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      this.log.warn('a signed delivery on /webhooks/didit did not carry readable json');
      return;
    }

    const sent = Number((payload as any)?.timestamp);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(sent) || Math.abs(now - sent) >= DIDIT_FRESHNESS_SECS) {
      this.log.warn('a signed delivery carried a time this anchor will not order by');
      this.refusals.record('a delivery carried a time this anchor will not order by');
      return;
    }

    const conclusion = readDiditDecision(payload);
    if (conclusion.unrecognisedStatus !== undefined) {
      this.log.warn(
        `a delivery reported a status this anchor does not recognise: ${JSON.stringify(
          conclusion.unrecognisedStatus.slice(0, 40),
        )}`,
      );
    }
    await this.sep12.applyDelivery(conclusion, new Date(sent * 1000));
  }
}
