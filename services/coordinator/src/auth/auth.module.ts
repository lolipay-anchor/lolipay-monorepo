import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AppConfigService } from '../config/app-config.service';
import { AuthService } from './auth.service';
import { PersonModule } from '../person/person.module';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { RolesGuard } from './roles.guard';
import { ConsumedChallengeService } from './consumed-challenge.service';

@Module({
  imports: [
    PersonModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (cfg: AppConfigService) => ({ secret: cfg.jwtSecret }),
    }),
  ],
  controllers: [AuthController],
  providers: [ConsumedChallengeService, AuthService, JwtStrategy, RolesGuard],
  exports: [AuthService, RolesGuard],
})
export class AuthModule {}
