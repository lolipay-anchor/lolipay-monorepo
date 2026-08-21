import { IsIn, IsOptional } from 'class-validator';

export const METRICS_RANGES = ['24h', '7d', '30d'] as const;
export type MetricsRange = (typeof METRICS_RANGES)[number];

export class MetricsOverviewQueryDto {
  @IsIn(METRICS_RANGES, {
    message: `range must be one of: ${METRICS_RANGES.join(', ')}`,
  })
  @IsOptional()
  range?: MetricsRange;
}
