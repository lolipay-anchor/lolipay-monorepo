import { IsBoolean, IsEnum, IsOptional, IsString, IsNotEmpty, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { RailEnum } from './add-payment-method.dto';
import {
  NO_CONTROL_OR_FORMAT_CHARS_RE,
  normalizePaymentMethodLabel,
  PAYMENT_METHOD_LABEL_HAS_LETTERS_RE,
  PAYMENT_METHOD_LABEL_LENGTH_RE,
  PAYMENT_METHOD_LABEL_MAX_LEN,
} from '../../order/payment-destination';

export class UpdatePaymentMethodDto {
  @IsEnum(RailEnum)
  @IsOptional()
  rail?: RailEnum;

  @Transform(({ value }) => normalizePaymentMethodLabel(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(PAYMENT_METHOD_LABEL_MAX_LEN)
  @Matches(PAYMENT_METHOD_LABEL_LENGTH_RE)
  @Matches(NO_CONTROL_OR_FORMAT_CHARS_RE)
  @Matches(PAYMENT_METHOD_LABEL_HAS_LETTERS_RE)
  @IsOptional()
  label?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @IsOptional()
  details?: string;

  @IsBoolean()
  @IsOptional()
  active?: boolean;
}
