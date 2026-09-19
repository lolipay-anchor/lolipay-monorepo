import { IsBoolean, IsEnum, IsOptional, IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { RailEnum } from './add-payment-method.dto';

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
  @IsOptional()
  details?: string;

  @IsBoolean()
  @IsOptional()
  active?: boolean;
}
