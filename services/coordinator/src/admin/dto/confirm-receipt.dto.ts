import { IsInt, IsString, MaxLength } from 'class-validator';

export class ConfirmReceiptDto {
  @IsInt()
  at!: number;

  @IsString()
  @MaxLength(256)
  signature!: string;
}
