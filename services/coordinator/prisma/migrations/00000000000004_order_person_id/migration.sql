-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "personId" TEXT;

-- CreateIndex
CREATE INDEX "Order_personId_idx" ON "Order"("personId");

WITH missing AS (
    SELECT DISTINCT o."userAddress" AS addr
    FROM "Order" o
    LEFT JOIN "WalletLink" w ON w."stellarAddress" = o."userAddress"
    WHERE w."stellarAddress" IS NULL
),
created AS MATERIALIZED (
    SELECT addr, gen_random_uuid()::text AS pid FROM missing
),
inserted_person AS (
    INSERT INTO "Person" ("id", "createdAt", "updatedAt")
    SELECT pid, now(), now() FROM created
)
INSERT INTO "WalletLink" ("stellarAddress", "personId", "authMethod", "status", "provenAt")
SELECT addr, pid, 'SEP53'::"WalletAuthMethod", 'ACTIVE'::"WalletLinkStatus", now()
FROM created;

UPDATE "Order" o
SET "personId" = w."personId"
FROM "WalletLink" w
WHERE w."stellarAddress" = o."userAddress" AND o."personId" IS NULL;
