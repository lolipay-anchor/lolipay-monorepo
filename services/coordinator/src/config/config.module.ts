import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { AppConfigService } from './app-config.service';
import { ConfigBootService } from './config-boot.service';

@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
  providers: [AppConfigService, ConfigBootService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
