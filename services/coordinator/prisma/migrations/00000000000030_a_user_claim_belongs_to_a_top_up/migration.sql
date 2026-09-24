-- AddCheckConstraint
ALTER TABLE "Order"
  ADD CONSTRAINT a_user_claim_belongs_to_a_top_up
  CHECK ("userClaimedPaidAt" IS NULL OR flow = 'TOP_UP');
