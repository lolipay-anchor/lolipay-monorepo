import { Controller, HttpCode, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { verifyDiditDelivery } from './didit-signature';
import { readDiditDecision } from './didit-decision';
import { Sep12Service } from './sep12.service';

@Controller('webhooks')
export class DiditWebhookController {
  private readonly log = new Logger(DiditWebhookController.name);

  constructor(
    private cfg: AppConfigService,
    private sep12: Sep12Service,
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
      throw new UnauthorizedException('this delivery was not signed by the shared secret');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      this.log.warn('a signed delivery on /webhooks/didit did not carry readable json');
      return;
    }

    const conclusion = readDiditDecision(payload);
    if (conclusion.unrecognisedStatus !== undefined) {
      this.log.warn(
        `a delivery reported a status this anchor does not recognise: ${conclusion.unrecognisedStatus}`,
      );
    }
    const sent = Number((payload as any)?.timestamp);
    const deliveredAt = Number.isFinite(sent) ? new Date(sent * 1000) : new Date();
    await this.sep12.applyDelivery(conclusion, deliveredAt);
  }
}
