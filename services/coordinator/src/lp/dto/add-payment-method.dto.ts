import { IsEnum, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export enum RailEnum {
  BANK = 'BANK',
  QRIS = 'QRIS',
  EWALLET = 'EWALLET',
}

export const PAYMENT_DETAILS_MIN_NON_WS_RE = /^(?:\s*\S){6}/;
export const PAYMENT_DETAILS_MIN_NON_WS_MESSAGE =
  'details must contain at least 6 non-whitespace characters — enter a real payment destination';

export class AddPaymentMethodDto {
  @IsEnum(RailEnum)
  rail!: RailEnum;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  label!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Matches(PAYMENT_DETAILS_MIN_NON_WS_RE, { message: PAYMENT_DETAILS_MIN_NON_WS_MESSAGE })
  details!: string;
}
