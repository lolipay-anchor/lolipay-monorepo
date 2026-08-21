import { Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { NotificationService } from './notification.service';

@Controller('notifications')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class NotificationController {
  constructor(private notif: NotificationService) {}

  @Get()
  @Roles('user', 'lp', 'admin')
  async list(@Req() req: any) {
    const [items, unread] = await Promise.all([
      this.notif.list(req.user.address),
      this.notif.unreadCount(req.user.address),
    ]);
    return { items, unread };
  }

  @Post('read')
  @HttpCode(200)
  @Roles('user', 'lp', 'admin')
  async readAll(@Req() req: any) {
    await this.notif.markAllRead(req.user.address);
    return { ok: true };
  }
}
