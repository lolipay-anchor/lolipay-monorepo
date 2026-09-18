import { IsBoolean, IsEnum, IsOptional, IsString, IsNotEmpty, Matches, MaxLength } from 'class-validator';
import {
  PAYMENT_DETAILS_MIN_NON_WS_MESSAGE,
  PAYMENT_DETAILS_MIN_NON_WS_RE,
  RailEnum,
} from './add-payment-method.dto';

export class UpdatePaymentMethodDto {
  @IsEnum(RailEnum)
  @IsOptional()
  rail?: RailEnum;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @IsOptional()
  label?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Matches(PAYMENT_DETAILS_MIN_NON_WS_RE, { message: PAYMENT_DETAILS_MIN_NON_WS_MESSAGE })
  @IsOptional()
  details?: string;

  @IsBoolean()
  @IsOptional()
  active?: boolean;
}
