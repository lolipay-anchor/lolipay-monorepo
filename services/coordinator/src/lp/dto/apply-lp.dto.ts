import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ApplyLpDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  contact!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  liquidityProof!: string;
}
