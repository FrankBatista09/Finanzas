-- FE Finance: a budget entry can say which income it was taken from.
-- Additive only: the column is nullable and every existing row keeps NULL (taken from the account as a whole).
-- It is a plain column and not a foreign key because SQLite cannot add a composite one with ALTER; the app checks
-- that the income exists, belongs to the same user and is in the same account as the entry, and refuses to delete
-- an income that entries still point to.

ALTER TABLE month_budget_log ADD COLUMN income_id TEXT;
