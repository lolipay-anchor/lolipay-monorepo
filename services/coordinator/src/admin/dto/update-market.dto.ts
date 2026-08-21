import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

const NUMERIC_STRING = /^\d+(\.\d+)?$/;

export class UpdateMarketDto {
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsString()
  @Matches(NUMERIC_STRING, {
    message: 'manualRateOverride must be a positive numeric string (e.g. "16000")',
  })
  @IsOptional()
  manualRateOverride?: string | null;

  @IsString()
  @Matches(NUMERIC_STRING, {
    message: 'priceMinPerUsdc must be a positive numeric string (e.g. "5000")',
  })
  @IsOptional()
  priceMinPerUsdc?: string;

  @IsString()
  @Matches(NUMERIC_STRING, {
    message: 'priceMaxPerUsdc must be a positive numeric string (e.g. "50000")',
  })
  @IsOptional()
  priceMaxPerUsdc?: string;

  @IsString()
  @IsNotEmpty({ message: 'railName must not be empty' })
  @IsOptional()
  railName?: string;
}
