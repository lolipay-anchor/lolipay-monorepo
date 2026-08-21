import { IsString, Matches } from 'class-validator';
export class ChallengeDto {
  @IsString()
  @Matches(/^G[A-Z2-7]{55}$/)
  address!: string;
}
