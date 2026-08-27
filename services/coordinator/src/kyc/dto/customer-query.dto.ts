import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CustomerQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  account?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  memo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  memo_type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  lang?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  transaction_id?: string;
}
