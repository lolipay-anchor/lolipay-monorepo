-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "lpPaymentLabel" VARCHAR(64),
ADD COLUMN     "userClaimedPaidAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PaymentMethod" ALTER COLUMN "label" SET DATA TYPE VARCHAR(64);

UPDATE "Order" o
SET "lpPaymentLabel" = pm."label"
FROM "PaymentMethod" pm
WHERE o."paymentMethodId" = pm.id
  AND o."lpPaymentLabel" IS NULL
  AND o.status IN ('MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID');
