import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { normalizePaymentMethodLabel } from '../../order/payment-destination';
import {
  HasNoDisallowedPaymentMethodChars,
  HasReadablePaymentMethodName,
  IsPaymentMethodLabelLength,
} from './payment-method-label.validators';

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
  @IsPaymentMethodLabelLength()
  @HasNoDisallowedPaymentMethodChars()
  @HasReadablePaymentMethodName()
  label!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  details!: string;
}
