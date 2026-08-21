import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { RealtimeGateway } from './realtime.gateway';

@Global()
@Module({
  imports: [
    PrismaModule,
    AppConfigModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],

      useFactory: (cfg: AppConfigService) => ({
        secret: cfg.jwtSecret,
        signOptions: { algorithm: 'HS256' },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
