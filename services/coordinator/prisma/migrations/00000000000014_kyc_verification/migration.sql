
-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NEEDS_INFO', 'PROCESSING', 'ACCEPTED', 'REJECTED');

-- CreateTable
CREATE TABLE "KycVerification" (
    "customerRef" TEXT NOT NULL,
    "personId" TEXT,
    "status" "KycStatus" NOT NULL DEFAULT 'NEEDS_INFO',
    "providerRef" TEXT,
    "rejectionReason" TEXT,
    "screenedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KycVerification_pkey" PRIMARY KEY ("customerRef")
);

-- CreateIndex
CREATE INDEX "KycVerification_personId_idx" ON "KycVerification"("personId");

-- CreateIndex
CREATE INDEX "KycVerification_status_idx" ON "KycVerification"("status");

-- AddForeignKey
ALTER TABLE "KycVerification" ADD CONSTRAINT "KycVerification_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
