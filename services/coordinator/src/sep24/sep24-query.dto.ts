import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const SEP24_PAGE_DEFAULT = 100;
export const SEP24_PAGE_MAX = 500;

export class TransactionsQueryDto {
  @IsOptional() @IsString() @MaxLength(64) asset_code?: string;
  @IsOptional() @IsString() @MaxLength(64) kind?: string;
  @IsOptional() @IsString() @MaxLength(64) no_older_than?: string;
  @IsOptional() @IsString() @MaxLength(96) account?: string;
  @IsOptional() @IsString() @MaxLength(64) lang?: string;
  @IsOptional() @IsString() @MaxLength(64) paging_id?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(SEP24_PAGE_MAX) limit?: number;
}

export class TransactionQueryDto {
  @IsOptional() @IsString() @MaxLength(64) id?: string;
  @IsOptional() @IsString() @MaxLength(96) stellar_transaction_id?: string;
  @IsOptional() @IsString() @MaxLength(96) external_transaction_id?: string;
  @IsOptional() @IsString() @MaxLength(64) lang?: string;
}
