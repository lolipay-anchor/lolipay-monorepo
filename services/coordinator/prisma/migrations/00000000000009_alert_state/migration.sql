-- CreateTable
CREATE TABLE "AlertState" (
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSentAt" TIMESTAMP(3) NOT NULL,
    "sendCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AlertState_pkey" PRIMARY KEY ("key")
);
