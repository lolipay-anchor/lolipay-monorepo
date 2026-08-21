import { IsString, IsNotEmpty, IsUUID, IsOptional, MaxLength, Matches } from 'class-validator';

export const NO_CONTROL_CHARS_RE = /^[^\x00-\x1F\x7F]*$/;
export const MERCHANT_MAX_LEN = 80;

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  @IsUUID()
  quoteId!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  userPaymentMethod?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  qrisPayload?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MERCHANT_MAX_LEN)
  @Matches(NO_CONTROL_CHARS_RE, { message: 'merchant must not contain control characters' })
  merchant?: string;
}
