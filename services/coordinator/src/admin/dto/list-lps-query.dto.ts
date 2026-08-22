import { IsEnum, IsOptional } from 'class-validator';
import { LpStatus } from '../../generated/prisma/client';

export class ListLpsQueryDto {
  @IsEnum(LpStatus)
  @IsOptional()
  status?: LpStatus;
}
