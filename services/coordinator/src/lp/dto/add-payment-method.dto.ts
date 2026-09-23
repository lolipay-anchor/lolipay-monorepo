import { IsEnum, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { NO_CONTROL_OR_FORMAT_CHARS_RE } from '../../order/payment-destination';

export enum RailEnum {
  BANK = 'BANK',
  QRIS = 'QRIS',
  EWALLET = 'EWALLET',
}

export class AddPaymentMethodDto {
  @IsEnum(RailEnum)
  rail!: RailEnum;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(NO_CONTROL_OR_FORMAT_CHARS_RE)
  label!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  details!: string;
}
