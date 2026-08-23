-- CreateTable
CREATE TABLE "Sep10ConsumedChallenge" (
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sep10ConsumedChallenge_pkey" PRIMARY KEY ("nonce")
);

-- CreateIndex
CREATE INDEX "Sep10ConsumedChallenge_expiresAt_idx" ON "Sep10ConsumedChallenge"("expiresAt");

