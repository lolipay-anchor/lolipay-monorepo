-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "slashDeadline" BIGINT,
ADD COLUMN     "liabilityEstablished" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Order_liabilityEstablished_slashDeadline_idx" ON "Order"("liabilityEstablished", "slashDeadline");
