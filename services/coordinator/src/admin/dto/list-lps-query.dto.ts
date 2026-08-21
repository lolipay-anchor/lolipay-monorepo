import { IsEnum, IsOptional } from 'class-validator';
import { LpStatus } from '@prisma/client';

export class ListLpsQueryDto {
  @IsEnum(LpStatus)
  @IsOptional()
  status?: LpStatus;
}
