import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';

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
  @MaxLength(500)
  label!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  details!: string;
}
