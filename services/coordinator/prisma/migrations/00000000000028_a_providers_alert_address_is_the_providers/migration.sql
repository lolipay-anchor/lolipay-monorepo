-- AlterTable
ALTER TABLE "Lp" ADD COLUMN     "alertEmail" VARCHAR(254);

-- AddCheckConstraint
ALTER TABLE "Lp"
  ADD CONSTRAINT lp_alert_email_is_an_address
  CHECK ("alertEmail" IS NULL OR ("alertEmail" ~ '^.+@.+$' AND "alertEmail" !~ '[[:space:][:cntrl:]]'));
