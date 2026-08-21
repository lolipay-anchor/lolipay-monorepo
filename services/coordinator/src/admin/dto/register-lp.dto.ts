import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class RegisterLpDto {
  @IsString()
  @Matches(/^G[A-Z2-7]{55}$/, {
    message: 'stellarAddress must be a valid Stellar public key (G…, 56 chars)',
  })
  stellarAddress!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  contact!: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  liquidityProof?: string;

  @IsBoolean()
  @IsOptional()
  approve?: boolean;
}
