-- FE Finance: cashback on credit cards. Additive: every row is kept, both columns default to "off / nothing".
--  · credit_cards.cashback: the card earns cashback (1) or not (0)
--  · month_cards.cashback: what the card generated in that month, in the card's currency (>= 0); it reduces what is owed
ALTER TABLE credit_cards ADD COLUMN cashback INTEGER NOT NULL DEFAULT 0;
ALTER TABLE month_cards ADD COLUMN cashback REAL NOT NULL DEFAULT 0;
