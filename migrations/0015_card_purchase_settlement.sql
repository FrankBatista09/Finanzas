-- FE Finance: per-purchase settlement of credit-card purchases. Additive: every row is kept.
--  · transactions.card_payment_id: the card_payments row that covered this purchase (NULL = unsettled).
-- It is a plain column on purpose (card_payments has a composite key and 0011 already had to rebuild it once);
-- the app validates it and clears it when the payment is removed.
ALTER TABLE transactions ADD COLUMN card_payment_id TEXT;
