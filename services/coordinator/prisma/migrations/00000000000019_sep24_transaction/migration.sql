-- CreateTable
CREATE TABLE "Sep24Transaction" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "stellarAccount" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "orderId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sep24Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sep24Transaction_orderId_key" ON "Sep24Transaction"("orderId");

-- CreateIndex
CREATE INDEX "Sep24Transaction_stellarAccount_startedAt_idx" ON "Sep24Transaction"("stellarAccount", "startedAt");

-- CreateIndex
CREATE INDEX "Sep24Transaction_personId_idx" ON "Sep24Transaction"("personId");

-- AddForeignKey
ALTER TABLE "Sep24Transaction" ADD CONSTRAINT "Sep24Transaction_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sep24Transaction" ADD CONSTRAINT "Sep24Transaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
