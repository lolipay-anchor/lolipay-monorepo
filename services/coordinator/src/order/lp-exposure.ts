import type { Prisma } from '../generated/prisma/client';
import {
  SLASH_CEILING_PAST_POST_SETTLE_SECS,
  LONGEST_TAIL_PAST_SETTLEMENT_SECS,
} from '../config/contract-limits';


export const LP_CAPACITY_LOCK_NAMESPACE = 1;

export type ExposureClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

export async function lpExposure(
  tx: ExposureClient,
  lpId: string,
  nowSec: number,
): Promise<bigint> {
  const ceiling = SLASH_CEILING_PAST_POST_SETTLE_SECS;
  const longestTail = LONGEST_TAIL_PAST_SETTLEMENT_SECS;
  const rows = await tx.$queryRaw<{ total: string }[]>`
    SELECT COALESCE(SUM("usdcAmount"), 0)::text AS total
      FROM "Order"
     WHERE "lpId" = ${lpId}
       AND "status"::text NOT IN ('EXPIRED', 'CANCELLED')
       AND NOT ("status"::text = 'RELEASED' AND "flow"::text = 'TOP_UP')
       AND NOT ("status"::text = 'REFUNDED' AND "flow"::text = 'WITHDRAW')
       AND (
         "settledAt" IS NULL
         OR CASE
              WHEN "slashDeadline" IS NULL AND "postSettleDeadline" IS NULL
                THEN EXTRACT(EPOCH FROM "settledAt")::bigint + ${longestTail}::bigint
              ELSE GREATEST(
                     COALESCE("slashDeadline", 0),
                     COALESCE("postSettleDeadline", 0)
                       + CASE WHEN "status"::text = 'DISPUTED' OR "disputeAt" IS NOT NULL
                              THEN ${ceiling}::bigint ELSE 0 END
                   )
            END >= ${nowSec}::bigint
       )
  `;
  return BigInt(rows[0]?.total ?? '0');
}
