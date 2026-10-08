-- FE Finance: la lista de métodos de pago pasa a distinguir tarjeta de débito y de crédito (y añade efectivo).
-- Lo guardado hasta hoy como 'Card' era, en la práctica, la tarjeta de débito: pasa a llamarse 'Debit card',
-- el nombre canónico de hoy (shared/constants.ts METHODS). Vale para todos los usuarios; lo demás no se toca
-- (un método de texto libre, como 'card' en minúsculas escrito a mano, se queda como está).

UPDATE transactions SET method = 'Debit card' WHERE method = 'Card';
