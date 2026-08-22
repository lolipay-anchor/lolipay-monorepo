-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "personId" TEXT;

-- CreateIndex
CREATE INDEX "Order_personId_idx" ON "Order"("personId");

