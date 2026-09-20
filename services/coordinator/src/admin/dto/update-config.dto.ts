import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  registerDecorator,
  ValidateIf,
  ValidationOptions,
} from 'class-validator';
import {
  MIN_USABLE_PAY_WINDOW_SECS,
  MAX_PAY_WINDOW_SECS,
  MAX_TOTAL_WINDOW_SECS,
} from '../../config/contract-limits';
import { TIER_LEVELS } from '../../reputation/user-reputation.service';

const MAX_DISPUTE_WINDOW_SECS = 604800;

const MAX_DAILY_LIMIT_USDC = 10_000_000;
const POSITIVE_INT_STRING = /^[1-9]\d*$/;

function IsDailyLimitByTier(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isDailyLimitByTier',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
          const limits = value as Record<string, unknown>;
          if (Object.keys(limits).length !== TIER_LEVELS.length) return false;
          return TIER_LEVELS.every((tier) => {
            const limit = limits[tier];
            return (
              Number.isInteger(limit) &&
              (limit as number) > 0 &&
              (limit as number) <= MAX_DAILY_LIMIT_USDC
            );
          });
        },
        defaultMessage() {
          return `dailyLimitByTier must name every tier (${TIER_LEVELS.join('|')}) and nothing else, each an integer from 1 to ${MAX_DAILY_LIMIT_USDC}: send all four values, including the ones you are not changing`;
        },
      },
    });
  };
}

export class UpdateConfigDto {
  @IsInt()
  @Min(0)
  @Max(9999)
  @IsOptional()
  spreadBps?: number;

  @IsInt()
  @Min(0)
  @Max(9999)
  @IsOptional()
  platformFeeBps?: number;

  @IsInt()
  @Min(0)
  @Max(9999)
  @IsOptional()
  lpFeeBps?: number;

  @IsString()
  @Matches(/^G[A-Z2-7]{55}$/, { message: 'platformWallet must be a valid Stellar public key (G...)' })
  @IsOptional()
  platformWallet?: string;

  @IsBoolean()
  @IsOptional()
  paused?: boolean;

  @IsBoolean()
  @IsOptional()
  requireProof?: boolean;

  @IsBoolean()
  @IsOptional()
  autoRefund?: boolean;

  @IsObject()
  @IsDailyLimitByTier()
  @ValidateIf((o: UpdateConfigDto) => o.dailyLimitByTier !== undefined)
  dailyLimitByTier?: Record<string, number>;

  @IsInt()
  @Min(1)
  @Max(MAX_DISPUTE_WINDOW_SECS)
  @IsOptional()
  postSettleDisputeWindowSecs?: number;

  @IsInt()
  @Min(MIN_USABLE_PAY_WINDOW_SECS)
  @Max(MAX_PAY_WINDOW_SECS)
  @IsOptional()
  payWindowSecs?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_TOTAL_WINDOW_SECS)
  @IsOptional()
  confirmWindowSecs?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_TOTAL_WINDOW_SECS)
  @IsOptional()
  disputeWindowSecs?: number;

  @IsString()
  @Matches(POSITIVE_INT_STRING, { message: 'minOrder must be a positive integer string (base units)' })
  @IsOptional()
  minOrder?: string;

  @IsString()
  @Matches(POSITIVE_INT_STRING, { message: 'maxOrder must be a positive integer string (base units)' })
  @IsOptional()
  maxOrder?: string;
}
