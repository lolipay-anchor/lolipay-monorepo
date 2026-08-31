import { IsString, Length } from 'class-validator';

export class AttestFiatPaidDto {
  @IsString()
  @Length(3, 200)
  evidence!: string;
}
