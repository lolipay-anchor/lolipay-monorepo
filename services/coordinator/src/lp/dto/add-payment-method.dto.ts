import { IsEnum, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import {
  NO_CONTROL_OR_FORMAT_CHARS_RE,
  normalizePaymentMethodLabel,
  PAYMENT_METHOD_LABEL_HAS_LETTERS_RE,
  PAYMENT_METHOD_LABEL_LENGTH_RE,
  PAYMENT_METHOD_LABEL_MAX_LEN,
} from '../../order/payment-destination';

export enum RailEnum {
  BANK = 'BANK',
  QRIS = 'QRIS',
  EWALLET = 'EWALLET',
}

export class AddPaymentMethodDto {
  @IsEnum(RailEnum)
  rail!: RailEnum;

  @Transform(({ value }) => normalizePaymentMethodLabel(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(PAYMENT_METHOD_LABEL_MAX_LEN)
  @Matches(PAYMENT_METHOD_LABEL_LENGTH_RE)
  @Matches(NO_CONTROL_OR_FORMAT_CHARS_RE)
  @Matches(PAYMENT_METHOD_LABEL_HAS_LETTERS_RE)
  label!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  details!: string;
}
