import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { MonitoringService } from './monitoring.service';

@Controller('metrics')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class MonitoringController {
  constructor(private monitoring: MonitoringService) {}

  @Get()
  @Roles('admin')
  metrics() {
    return this.monitoring.metrics();
  }
}
