-- CreateTable
CREATE TABLE "WalletLinkChallenge" (
    "nonce" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "stellarAddress" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletLinkChallenge_pkey" PRIMARY KEY ("nonce")
);

-- CreateIndex
CREATE INDEX "WalletLinkChallenge_personId_stellarAddress_idx" ON "WalletLinkChallenge"("personId", "stellarAddress");

-- CreateIndex
CREATE INDEX "WalletLinkChallenge_expiresAt_idx" ON "WalletLinkChallenge"("expiresAt");

