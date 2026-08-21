import { IsString, Matches } from 'class-validator';
export class VerifyDto {
  @IsString()
  @Matches(/^G[A-Z2-7]{55}$/)
  address!: string;

  @IsString()
  nonce!: string;

  @IsString()
  signature!: string;
}
