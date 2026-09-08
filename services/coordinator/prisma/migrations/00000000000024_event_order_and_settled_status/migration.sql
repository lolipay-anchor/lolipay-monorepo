-- AlterTable
ALTER TABLE "Order" ADD COLUMN "settledStatus" "OrderStatus";
ALTER TABLE "Order" ADD COLUMN "eventPos" BIGINT NOT NULL DEFAULT 0;

-- Backfill
UPDATE "Order" SET "settledStatus" = "status" WHERE "status" IN ('RELEASED', 'REFUNDED');
