-- FE Finance: a contribution to a goal can say which income it came from.
-- Additive only: the column is nullable and every existing row keeps NULL (taken from the account as a whole).
-- It is a plain column and not a foreign key because SQLite cannot add a composite one with ALTER; the app checks
-- that the income exists, belongs to the same user and is in the same account as the contribution's source
-- account, and refuses to delete or move an income that contributions still point to.

ALTER TABLE contributions ADD COLUMN income_id TEXT;
