import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class ChallengeQueryDto {
  @IsString()
  @Matches(/^[GM][A-Z2-7]+$/, { message: 'account must be a Stellar address' })
  @MaxLength(80)
  account!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  memo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  home_domain?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  client_domain?: string;
}
