import { IsBoolean, IsEnum, IsString, IsNotEmpty, MaxLength, ValidateIf } from 'class-validator';
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
  @ValidateIf((o: UpdatePaymentMethodDto) => o.rail !== undefined)
  rail?: RailEnum;

  @Transform(({ value }) => normalizePaymentMethodLabel(value))
  @IsString()
  @IsPaymentMethodLabelLength()
  @HasNoDisallowedPaymentMethodChars()
  @HasReadablePaymentMethodName()
  @ValidateIf((o: UpdatePaymentMethodDto) => o.label !== undefined)
  label?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @ValidateIf((o: UpdatePaymentMethodDto) => o.details !== undefined)
  details?: string;

  @IsBoolean()
  @ValidateIf((o: UpdatePaymentMethodDto) => o.active !== undefined)
  active?: boolean;
}
