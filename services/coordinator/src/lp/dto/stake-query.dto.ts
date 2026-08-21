import { IsNotEmpty, Matches } from 'class-validator';

export class StakeTxQueryDto {
  @IsNotEmpty({ message: 'amount is required' })
  @Matches(/^[1-9]\d*$/, {
    message: 'amount must be a positive integer string (e.g. "1000000000")',
  })
  amount!: string;
}
