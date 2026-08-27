ALTER TABLE "ConsumedChallenge" RENAME CONSTRAINT "Sep10ConsumedChallenge_pkey" TO "ConsumedChallenge_pkey";
ALTER INDEX "Sep10ConsumedChallenge_expiresAt_idx" RENAME TO "ConsumedChallenge_expiresAt_idx";
