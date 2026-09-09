-- AddCheckConstraint
ALTER TABLE "Order"
  ADD CONSTRAINT settled_rows_record_a_direction
  CHECK (status NOT IN ('RELEASED', 'REFUNDED') OR "settledStatus" IS NOT NULL);
