-- 024_send_fee_waiver.sql
--
-- Ops-controlled flag: when true, /send charges no network fee for this
-- account (treasury does not receive a fee line item). Useful for service /
-- treasury-adjacent bots that must move RPOW without burning per-send fees.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS send_fees_waived BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN accounts.send_fees_waived IS
  'When true, POST /send uses fee_base_units=0 for this sender (no treasury debit).';
