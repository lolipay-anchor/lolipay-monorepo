import { Controller, HttpCode, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AppConfigService } from '../config/app-config.service';
import { verifyDiditDelivery } from './didit-signature';

@Controller('webhooks')
export class DiditWebhookController {
  private readonly log = new Logger(DiditWebhookController.name);

  constructor(private cfg: AppConfigService) {}

  @Post('didit')
  @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  async receive(@Req() req: any): Promise<void> {
    const verdict = verifyDiditDelivery({
      raw: req.rawBody,
      signature: String(req.headers['x-signature'] ?? ''),
      timestamp: String(req.headers['x-timestamp'] ?? ''),
      secret: this.cfg.diditWebhookSecret,
    });

    if (!verdict.trusted) {
      this.log.warn(`refused a delivery on /webhooks/didit: ${verdict.reason}`);
      throw new UnauthorizedException('this delivery was not signed by the shared secret');
    }
  }
}
