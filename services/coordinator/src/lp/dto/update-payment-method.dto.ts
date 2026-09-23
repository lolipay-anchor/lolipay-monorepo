import { IsBoolean, IsEnum, IsOptional, IsString, IsNotEmpty, Matches, MaxLength } from 'class-validator';
import { RailEnum } from './add-payment-method.dto';
import { NO_CONTROL_OR_FORMAT_CHARS_RE } from '../../order/payment-destination';

export class UpdatePaymentMethodDto {
  @IsEnum(RailEnum)
  @IsOptional()
  rail?: RailEnum;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(NO_CONTROL_OR_FORMAT_CHARS_RE)
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
