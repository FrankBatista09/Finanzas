-- FE Finance: credit card purchases are added to a month before they count in the card total. Additive: every row is kept.
--  · transactions.card_month: the month whose card total includes this purchase (NULL = unpaid: not part of any month yet)
--  · transactions.card_fixed_id: the fixed expense row that represents the purchase in that month's table, when it was added
--    as a fixed expense (the purchase is then not counted a second time)
-- Until now every Credit-card purchase counted in the total of its own month, so the backfill puts each one there:
-- no existing figure changes. Purchases created after this migration start unpaid (NULL).
ALTER TABLE transactions ADD COLUMN card_month TEXT;
ALTER TABLE transactions ADD COLUMN card_fixed_id TEXT;
UPDATE transactions SET card_month = month_key WHERE method = 'Credit card';
