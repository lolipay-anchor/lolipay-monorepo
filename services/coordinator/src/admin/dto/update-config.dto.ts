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
  ValidationOptions,
} from 'class-validator';
import {
  MIN_PAY_WINDOW_SECS,
  MAX_PAY_WINDOW_SECS,
  MAX_TOTAL_WINDOW_SECS,
} from '../../config/contract-limits';

const MAX_DISPUTE_WINDOW_SECS = 604800;

const VALID_TIERS = ['BRONZE', 'SILVER', 'TRUSTED', 'GOLD'] as const;
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
          const entries = Object.entries(value as Record<string, unknown>);
          if (entries.length === 0) return false;
          return entries.every(
            ([tier, limit]) =>
              (VALID_TIERS as readonly string[]).includes(tier) &&
              Number.isInteger(limit) &&
              (limit as number) > 0,
          );
        },
        defaultMessage() {
          return `dailyLimitByTier must be a non-empty object mapping tier (${VALID_TIERS.join('|')}) to a positive integer`;
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
  @IsOptional()
  dailyLimitByTier?: Record<string, number>;

  @IsInt()
  @Min(1)
  @Max(MAX_DISPUTE_WINDOW_SECS)
  @IsOptional()
  postSettleDisputeWindowSecs?: number;

  @IsInt()
  @Min(MIN_PAY_WINDOW_SECS)
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
