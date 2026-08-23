import { IsString, MaxLength, MinLength } from 'class-validator';

export class TokenBodyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  transaction!: string;
}
