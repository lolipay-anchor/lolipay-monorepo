-- AlterTable
ALTER TABLE "Lp" ADD COLUMN "personId" TEXT;

UPDATE "Lp" l
SET "personId" = w."personId"
FROM "WalletLink" w
WHERE w."stellarAddress" = l."stellarAddress"
  AND w.status = 'ACTIVE';

-- AddForeignKey
ALTER TABLE "Lp"
  ADD CONSTRAINT "Lp_personId_fkey"
  FOREIGN KEY ("personId") REFERENCES "Person"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
