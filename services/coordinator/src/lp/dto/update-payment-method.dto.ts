import { IsBoolean, IsEnum, IsOptional, IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { RailEnum } from './add-payment-method.dto';
import { normalizePaymentMethodLabel } from '../../order/payment-destination';
import {
  HasNoDisallowedPaymentMethodChars,
  HasReadablePaymentMethodName,
  IsPaymentMethodLabelLength,
} from './payment-method-label.validators';

export class UpdatePaymentMethodDto {
  @IsEnum(RailEnum)
  @IsOptional()
  rail?: RailEnum;

  @Transform(({ value }) => normalizePaymentMethodLabel(value))
  @IsString()
  @IsPaymentMethodLabelLength()
  @HasNoDisallowedPaymentMethodChars()
  @HasReadablePaymentMethodName()
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
