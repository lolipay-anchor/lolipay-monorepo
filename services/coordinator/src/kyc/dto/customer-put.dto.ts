import { IsOptional, IsString, MaxLength } from 'class-validator';


export class CustomerPutDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  account?: string;

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
  @MaxLength(64)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  last_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  email_address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  id_type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  id_country_code?: string;
}
