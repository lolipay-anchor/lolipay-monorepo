-- CreateEnum
CREATE TYPE "WalletAuthMethod" AS ENUM ('SEP10', 'SEP53');
-- CreateEnum
CREATE TYPE "WalletLinkStatus" AS ENUM ('ACTIVE', 'REVOKED');
-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "WalletLink" (
    "stellarAddress" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "authMethod" "WalletAuthMethod" NOT NULL,
    "status" "WalletLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "provenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WalletLink_pkey" PRIMARY KEY ("stellarAddress")
);
-- CreateIndex
CREATE INDEX "WalletLink_personId_idx" ON "WalletLink"("personId");
-- AddForeignKey
ALTER TABLE "WalletLink" ADD CONSTRAINT "WalletLink_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
