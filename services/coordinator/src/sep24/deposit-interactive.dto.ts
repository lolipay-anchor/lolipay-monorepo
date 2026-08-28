import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DepositInteractiveDto {
  @IsOptional() @IsString() @MaxLength(64) asset_code?: string;
  @IsOptional() @IsString() @MaxLength(64) asset_issuer?: string;
  @IsOptional() @IsString() @MaxLength(96) account?: string;
  @IsOptional() @IsString() @MaxLength(32) amount?: string;
  @IsOptional() @IsString() @MaxLength(64) memo?: string;
  @IsOptional() @IsString() @MaxLength(16) memo_type?: string;
  @IsOptional() @IsString() @MaxLength(16) lang?: string;
  @IsOptional() @IsString() @MaxLength(8) claimable_balance_supported?: string;
  @IsOptional() @IsString() @MaxLength(64) customer_id?: string;
  @IsOptional() @IsString() @MaxLength(64) quote_id?: string;
  @IsOptional() @IsString() @MaxLength(256) first_name?: string;
  @IsOptional() @IsString() @MaxLength(256) last_name?: string;
  @IsOptional() @IsString() @MaxLength(256) email_address?: string;
  @IsOptional() @IsString() @MaxLength(32) mobile_number?: string;
  @IsOptional() @IsString() @MaxLength(8) id_type?: string;
  @IsOptional() @IsString() @MaxLength(8) id_country_code?: string;
}
