import { Controller, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { verifyDiditDelivery } from './didit-signature';

@Controller('webhooks')
export class DiditWebhookController {
  constructor(private cfg: AppConfigService) {}

  @Post('didit')
  @HttpCode(200)
  async receive(@Req() req: any): Promise<void> {
    const verdict = verifyDiditDelivery({
      raw: Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0),
      signature: String(req.headers['x-signature'] ?? ''),
      timestamp: String(req.headers['x-timestamp'] ?? ''),
      secret: this.cfg.diditWebhookSecret,
    });
    if (!verdict.trusted) {
      throw new UnauthorizedException('this delivery was not signed by the shared secret');
    }
  }
}
