-- CreateEnum
CREATE TYPE "LpStatus" AS ENUM ('PENDING', 'APPROVED', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "Rail" AS ENUM ('BANK', 'QRIS', 'EWALLET');

-- CreateEnum
CREATE TYPE "Flow" AS ENUM ('TOP_UP', 'WITHDRAW');

-- CreateEnum
CREATE TYPE "UserTier" AS ENUM ('BRONZE', 'SILVER', 'TRUSTED', 'GOLD');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'RELEASED', 'REFUNDED', 'DISPUTED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Lp" (
    "id" TEXT NOT NULL,
    "stellarAddress" TEXT NOT NULL,
    "status" "LpStatus" NOT NULL DEFAULT 'PENDING',
    "disputesLost" INTEGER NOT NULL DEFAULT 0,
    "contact" TEXT NOT NULL,
    "liquidityProof" TEXT NOT NULL,
    "approvalNote" TEXT,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "lastHeartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "Lp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "lpId" TEXT NOT NULL,
    "rail" "Rail" NOT NULL,
    "label" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "contractId" TEXT,
    "userAddress" TEXT NOT NULL,
    "lpId" TEXT,
    "flow" "Flow" NOT NULL,
    "rail" "Rail" NOT NULL,
    "usdcAmount" BIGINT NOT NULL,
    "fiatAmount" BIGINT NOT NULL,
    "fiatCurrency" TEXT NOT NULL DEFAULT 'IDR',
    "rateSnapshot" TEXT NOT NULL,
    "platformFeeBps" INTEGER NOT NULL,
    "lpFeeBps" INTEGER NOT NULL,
    "spreadBps" INTEGER NOT NULL DEFAULT 0,
    "platformWallet" TEXT NOT NULL,
    "lpWallet" TEXT,
    "paymentMethodId" TEXT,
    "lpPaymentDetails" TEXT,
    "userPaymentDetails" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "payDeadline" BIGINT NOT NULL,
    "confirmDeadline" BIGINT NOT NULL,
    "disputeDeadline" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ref" TEXT,
    "proofUrl" TEXT,
    "proofUploadedAt" TIMESTAMP(3),
    "proofRrn" TEXT,
    "proofAmount" BIGINT,
    "proofPaidAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "disputeBy" TEXT,
    "disputeReason" TEXT,
    "disputeNote" TEXT,
    "disputeEvidenceUrl" TEXT,
    "disputeAt" TIMESTAMP(3),
    "resolution" TEXT,
    "disputeLossAccrued" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProfile" (
    "address" TEXT NOT NULL,
    "disputesLost" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "userAddress" TEXT NOT NULL,
    "flow" "Flow" NOT NULL,
    "rail" "Rail" NOT NULL,
    "usdcAmount" BIGINT NOT NULL,
    "fiatAmount" BIGINT NOT NULL,
    "fiatCurrency" TEXT NOT NULL DEFAULT 'IDR',
    "rateSnapshot" TEXT NOT NULL,
    "platformFeeBps" INTEGER NOT NULL,
    "lpFeeBps" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "code" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "currencySymbol" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "railName" TEXT NOT NULL,
    "rateSource" TEXT NOT NULL DEFAULT 'coingecko',
    "manualRateOverride" TEXT,
    "priceMinPerUsdc" TEXT NOT NULL,
    "priceMaxPerUsdc" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "spreadBps" INTEGER NOT NULL DEFAULT 150,
    "platformFeeBps" INTEGER NOT NULL DEFAULT 30,
    "lpFeeBps" INTEGER NOT NULL DEFAULT 120,
    "platformWallet" TEXT NOT NULL DEFAULT '',
    "minOrder" BIGINT NOT NULL DEFAULT 50000000,
    "maxOrder" BIGINT NOT NULL DEFAULT 10000000000,
    "payWindowSecs" INTEGER NOT NULL DEFAULT 1800,
    "confirmWindowSecs" INTEGER NOT NULL DEFAULT 1800,
    "disputeWindowSecs" INTEGER NOT NULL DEFAULT 7200,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "requireProof" BOOLEAN NOT NULL DEFAULT true,
    "autoRefund" BOOLEAN NOT NULL DEFAULT true,
    "dailyLimitByTier" JSONB,
    "postSettleDisputeWindowSecs" INTEGER NOT NULL DEFAULT 3600,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiatPriceCache" (
    "fiat" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "pricePerUsdc" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiatPriceCache_pkey" PRIMARY KEY ("fiat")
);

-- CreateTable
CREATE TABLE "IndexerState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "cursor" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "orderId" TEXT,
    "event" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAudit" (
    "id" TEXT NOT NULL,
    "actorAddress" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Lp_stellarAddress_key" ON "Lp"("stellarAddress");

-- CreateIndex
CREATE INDEX "PaymentMethod_lpId_rail_active_idx" ON "PaymentMethod"("lpId", "rail", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Order_tradeId_key" ON "Order"("tradeId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_ref_key" ON "Order"("ref");

-- CreateIndex
CREATE INDEX "Order_userAddress_idx" ON "Order"("userAddress");

-- CreateIndex
CREATE INDEX "Order_lpId_status_idx" ON "Order"("lpId", "status");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_proofRrn_lpId_key" ON "Order"("proofRrn", "lpId");

-- CreateIndex
CREATE INDEX "Notification_address_read_idx" ON "Notification"("address", "read");

-- CreateIndex
CREATE INDEX "Notification_address_createdAt_idx" ON "Notification"("address", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_address_orderId_event_key" ON "Notification"("address", "orderId", "event");

-- CreateIndex
CREATE INDEX "AdminAudit_actorAddress_createdAt_idx" ON "AdminAudit"("actorAddress", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAudit_targetType_targetId_idx" ON "AdminAudit"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AdminAudit_createdAt_idx" ON "AdminAudit"("createdAt");

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_lpId_fkey" FOREIGN KEY ("lpId") REFERENCES "Lp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_lpId_fkey" FOREIGN KEY ("lpId") REFERENCES "Lp"("id") ON DELETE SET NULL ON UPDATE CASCADE;

