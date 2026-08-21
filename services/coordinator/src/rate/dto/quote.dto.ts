import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';

export class QuoteDto {
  @IsEnum(['TOP_UP', 'WITHDRAW'] as const)
  flow!: 'TOP_UP' | 'WITHDRAW';

  @IsEnum(['BANK', 'QRIS', 'EWALLET'] as const)
  rail!: 'BANK' | 'QRIS' | 'EWALLET';

  @IsOptional()
  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  usdcAmount?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[1-9][0-9]*$/)
  fiatAmount?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  fiat?: string;
}
