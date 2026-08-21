import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SetLpStatusDto {
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  note?: string;
}
