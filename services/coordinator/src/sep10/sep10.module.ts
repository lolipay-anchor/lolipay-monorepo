import { Module } from '@nestjs/common';
import { Sep10Controller } from './sep10.controller';
import { Sep10Service } from './sep10.service';
import { AccountSignersService } from './account-signers.service';
import { ConsumedChallengeService } from './consumed-challenge.service';
import { PersonModule } from '../person/person.module';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigService } from '../config/app-config.service';

@Module({
  imports: [
    PersonModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (cfg: AppConfigService) => ({ secret: cfg.jwtSecret }),
    }),
  ],
  controllers: [Sep10Controller],
  providers: [Sep10Service, AccountSignersService, ConsumedChallengeService],
  exports: [Sep10Service],
})
export class Sep10Module {}
