-- AlterTable
ALTER TABLE "Person" ADD COLUMN     "email" VARCHAR(254);

-- AddCheckConstraint
ALTER TABLE "Person"
  ADD CONSTRAINT person_email_is_an_address
  CHECK ("email" IS NULL OR ("email" ~ '^.+@.+$' AND "email" !~ '[[:space:][:cntrl:]]'));
