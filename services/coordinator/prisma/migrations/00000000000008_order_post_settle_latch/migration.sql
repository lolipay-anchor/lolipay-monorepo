-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "postSettleDeadline" BIGINT,
ADD COLUMN     "resolverDisputed" BOOLEAN NOT NULL DEFAULT false;
