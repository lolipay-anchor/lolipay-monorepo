import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AdminService } from './admin.service';
import { ConfirmReceiptDto } from './dto/confirm-receipt.dto';

@Controller('orders')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('user', 'lp', 'admin')
export class ProviderReceiptController {
  constructor(private admin: AdminService) {}

  @Get(':id/confirm-receipt')
  receiptToSign(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.receiptToSign(id, req.user.address);
  }

  @Post(':id/confirm-receipt')
  @HttpCode(200)
  confirmReceipt(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmReceiptDto) {
    return this.admin.confirmReceiptAsProvider(id, req.user.address, dto);
  }
}
