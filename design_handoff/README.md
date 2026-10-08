# Handoff: Finanzas personales (app web + exportación a Excel)

## Overview
App personal de finanzas para un usuario en República Dominicana que cobra en USD y gasta en DOP. Permite:
- Registrar transacciones del mes (fecha, descripción, lugar, categoría, método, monto, moneda, notas).
- Llevar los gastos mensuales fijos (mismos conceptos cada mes, monto variable) con estado pagado/no pagado.
- Registrar envíos USD → DOP (Remitly / PayPal) con su tasa; la tasa del mes es el promedio ponderado de esos envíos.
- Ver en cada pantalla: dinero total (cuenta USA en USD + cuenta RD en DOP), presupuesto planeado del mes, usado, disponible, y una dona de presupuesto con el valor usado al centro.
- Cerrar el mes: el mes queda en solo lectura como resumen y se crea el siguiente con los mismos gastos fijos sin pagar.
- Ahorros: ingreso de cada mes, metas (Fondo de emergencia, Ahorro personal, Viaje a Turquía con 3,000 USD/mes hasta oct-2027) y aportes.
- Exportar todo a un .xlsx con el mismo diseño (una hoja por mes + Ahorros + Config). Si no hay datos, se exporta la plantilla vacía.
- Recibir transacciones desde un chat con Claude (el usuario le dicta "gasté X en Y" y Claude lo registra).

Objetivo de despliegue: **Cloudflare Pages** (frontend) + **Pages Functions / Workers** (API) + **D1** (histórico).

## About the Design Files
Los archivos en `referencia/` son **referencias de diseño hechas en HTML**: un prototipo que muestra el aspecto y el comportamiento esperados, no código de producción para copiar tal cual. La tarea es **recrear este diseño** en un proyecto nuevo. Stack recomendado (no hay codebase previa):
- Frontend: React + Vite + TypeScript, desplegado en Cloudflare Pages.
- API: Pages Functions (`/functions/api/*`) con binding a D1.
- Estilos: CSS modules o Tailwind con los tokens de abajo. Todo se renderiza en el cliente; no hace falta SSR.

`referencia/excel-export.js` **sí es reutilizable**: genera el .xlsx sin dependencias (OOXML + zip sin compresión). Se puede portar a TypeScript y usar en el cliente o en un Worker.

## Fidelity
**Alta fidelidad (hifi).** Colores, tipografía, espaciados e interacciones son finales. Recrear fiel al prototipo.

## Screens / Views

Layout general: fondo `#EFEEE8`; contenido centrado `max-width: 1320px`, padding `20px 24px 90px`, gap vertical 20px. Barra superior sticky oscura; barra de pestañas fija abajo (estilo pestañas de hoja de cálculo).

### Barra superior (todas las pantallas)
- Fondo `#1D1F1C`, texto `#F4F3EE`, padding `10px 24px`, flex-wrap, gap `12px 20px`.
- Izquierda: "Finanzas personales" (700, 16px) + subtítulo de estado (12px, `#A9ABA3`): "Mes en curso" / "Resumen del mes" / "Ahorros".
- Selector de mes: botón ‹, `<select>` (min-width 190px, alto 30px, fondo `#2B2E29`, borde `#3A3D38`, radio 3px), botón ›. Opciones "Octubre 2026", con sufijo " · cerrado" en los meses cerrados.
- Botón "Cargar Excel" (outline) y botón "Descargar Excel" (fondo `#2F7D52`, hover `#23613F`).
- Chip "Tasa del mes · 1 USD = 58.76 DOP" (monoespaciada).

### Panel resumen (arriba en todas las pantallas)
Grid `repeat(auto-fit, minmax(280px, 1fr))`, separado por líneas de 1px `#E3E1D8`, borde 1px, radio 4px, celdas fondo `#FFFEFA`, padding `18px 20px`.
1. **Dinero total**: etiqueta (11px, 600, uppercase, tracking .06em, `#6B6D66`); total en DOP (mono 28px 600) = `cuentaUSA × tasa + cuentaRD`; "≈ X USD" (mono 13px, muted). Mini tabla editable: Cuenta USA (USD), Cuenta RD (DOP). Fila separada por borde punteado: "Ingreso del mes − usado" = `ingresoUSD × tasa − usado` (rojo si es negativo).
2. **Dona** 168×168, r=64, grosor 20, hueco: segmentos en este orden: Fijos pagados `#2B3A33`, Transacciones `#2F7D52`, Fijos pendientes `#C9D3C9`, fondo/libre `#EBE9E1`. Escala = `max(presupuesto, usado + pendientes)`. Centro: etiqueta "USADO" + monto usado (mono 19px 600; rojo `#B23A2A` si se pasa del presupuesto) + "de 70,000 DOP". La leyenda va a la derecha con el valor de cada segmento.
3. **Presupuesto del mes** (lista label/valor con separadores `#EEECE5`): Presupuesto planeado (input editable), Usado hasta hoy, Disponible (verde `#23613F` / rojo si < 0), Disponible tras fijos pendientes, Usado en USD.

### Pantalla "Mes"
- **Banner de mes cerrado** (solo en meses cerrados): fondo `#1D1F1C`. Muestra Ingreso, Gastado, Ahorrado y Vs. presupuesto, más el botón "Reabrir mes".
- Fila flex-wrap con gap de 20px:
  - **Gastos mensuales** (flex 1 1 600px): tabla con las columnas Pagado (checkbox, accent `#2F7D52`), Concepto, Día, Monto, Moneda (DOP/USD), DOP (calc), USD (calc) y eliminar ×. La fila final sirve para agregar (fondo `#F9F8F3`). La meta del encabezado dice "6 de 11 pagados · total 42,025.57 DOP".
  - Columna derecha (flex 1 1 340px):
    - **Por categoría**: barras horizontales (alto 8px). "Gastos fijos" va en `#2B3A33` y el resto en `#2F7D52`, ordenadas de mayor a menor.
    - **Envíos USD → DOP**: tabla con Fecha, Vía (Remitly/PayPal), USD, Tasa y DOP (calc). Tiene fila para agregar.
- **Historial de transacciones**, a todo el ancho: la fila para agregar va arriba, seguida de las filas ordenadas por fecha descendente. Columnas: Fecha, Descripción, Lugar, Categoría, Método, Monto, Mon., DOP, USD, Notas y ×. Ancho mínimo de 980px con scroll horizontal.
- Caja punteada para cerrar el mes, con el texto "Al cerrar el mes se guarda este resumen y se crea Noviembre 2026…" y el botón "Cerrar Octubre 2026" (fondo `#1D1F1C`).
- **Modal de cierre**: el título es "Cerrar Octubre 2026" y el texto explica que se creará el mes siguiente y pregunta si también se agrega al Excel. Tiene tres botones: Cancelar, "Solo en la página" y "Sí, agregar al Excel" (este cierra el mes y descarga el .xlsx).

### Pantalla "Ahorros"
- Tarjetas de metas en un grid `auto-fit minmax(260px,1fr)`. Cada tarjeta muestra el nombre, el tipo ("Aportes variables" o "3,000 USD / mes"), el total ahorrado en USD (mono 24px) y su equivalente en DOP.
  - Turquía además tiene barra de progreso, "X% de 45,000 USD", la meta (oct 2027) y "Faltan N aportes · X USD por mes para llegar".
- **Ingresos por mes**: tabla con Mes, Ingreso USD (editable), Tasa, Ingreso DOP, Ahorrado USD y % ahorro.
- **Aportes**: tabla con Fecha, Meta, Monto, Moneda, USD y DOP. Tiene fila para agregar.

### Celdas tipo hoja de cálculo (común)
- `th`: 11px, 600, uppercase, tracking .06em, `#6B6D66`, fondo `#F6F5F0`, borde inferior `#E3E1D8`, derecho `#EBE9E2`.
- `td`: borde inferior `#EEECE5` y derecho `#F1EFE9`. El input ocupa toda la celda, sin borde y con fondo transparente, padding `7px 10px`.
- Foco de una celda: `box-shadow: inset 0 0 0 2px #2F7D52` y fondo `#fff`, como la selección de Excel.
- Los números van alineados a la derecha en mono 12.5px. En los meses cerrados todo es de solo lectura y se ocultan las filas de agregar y los botones ×.

## Interactions & Behavior
- **Tasa del mes**: `Σ(usd × tasa) / Σ(usd)` de los envíos del mes. Si no hay envíos, se usa la del mes anterior más reciente; si tampoco hay, 58.76.
- **Conversión**: si la moneda es USD, el monto en DOP es `monto × tasa del mes`, y el USD equivalente es `DOP / tasa`.
- **Cálculos del mes**:
  - `fijosPagados = Σ DOP de los fijos pagados`
  - `transacciones = Σ DOP de las transacciones`
  - `usado = fijosPagados + transacciones`
  - `pendientes = Σ DOP de los fijos no pagados`
  - `disponible = presupuesto − usado`
  - `trasFijos = disponible − pendientes`
- **Cerrar mes**: marca el mes como `closed`. Crea el mes siguiente si no existe, copiando los fijos con `paid=false` y el mismo presupuesto e ingreso; los envíos y las transacciones empiezan vacíos.
- **Reabrir mes**: vuelve a poner `closed=false`.
- **Agregar**: valida que tenga descripción y monto > 0 (transacción), concepto y monto > 0 (fijo), o USD y tasa > 0 (envío). Después de agregar limpia los campos y mantiene la fecha.
- **Exportar Excel**: un libro con una hoja por mes ("Octubre 2026"), además de las hojas Ahorros y Config. Ver `referencia/excel-export.js` y `referencia/Finanzas Personales v3.xlsx`. Sin datos, sale la plantilla vacía del mes actual (`referencia/Plantilla vacia.xlsx`).
- **Importar Excel**: lee el mismo formato y localiza las tablas por sus encabezados ("Concepto", "Fecha"+"Vía", "Fecha"+"Descripción"). Ver `importExcel` en el prototipo.
- **Responsive**: las columnas pasan a una sola con flex-wrap, y las tablas tienen scroll horizontal.

## Arquitectura propuesta (Cloudflare)
- **Pages**: el build de Vite. **Pages Functions** en `/functions/api/[[route]].ts` (o Hono).
- **Auth**: Cloudflare Access delante de todo el sitio, porque es una app de un solo usuario. Para que Claude pueda escribir, usar un token Bearer aparte, guardado como secret (`API_TOKEN`), válido solo en las rutas `/api/ingest/*` y `/mcp`.
- **D1**: es la fuente de verdad del histórico. El Excel queda como formato de exportación/importación.

### Esquema D1 (sugerido)
```sql
CREATE TABLE months (key TEXT PRIMARY KEY, budget_dop REAL, income_usd REAL, acc_usd REAL, acc_dop REAL, closed INTEGER DEFAULT 0, closed_at TEXT);
CREATE TABLE fixed_expenses (id TEXT PRIMARY KEY, month_key TEXT NOT NULL REFERENCES months(key), name TEXT NOT NULL, day TEXT, amount REAL NOT NULL, currency TEXT NOT NULL CHECK (currency IN ('DOP','USD')), paid INTEGER DEFAULT 0, sort INTEGER);
CREATE TABLE transactions (id TEXT PRIMARY KEY, month_key TEXT NOT NULL REFERENCES months(key), date TEXT NOT NULL, description TEXT NOT NULL, place TEXT, category TEXT NOT NULL, method TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL, notes TEXT, source TEXT DEFAULT 'web', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE transfers (id TEXT PRIMARY KEY, month_key TEXT NOT NULL REFERENCES months(key), date TEXT NOT NULL, via TEXT NOT NULL, usd REAL NOT NULL, rate REAL NOT NULL);
CREATE TABLE goals (id TEXT PRIMARY KEY, name TEXT NOT NULL, monthly_usd REAL, start_month TEXT, end_month TEXT);
CREATE TABLE contributions (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), date TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX tx_month ON transactions(month_key, date);
```
- Categorías: Comida, Supermercado, Transporte, Entretenimiento, Salud, Ropa, Hogar, Suscripciones, Educación, Viajes.
- Métodos: Tarjeta, Transferencia, App del banco.
- La transacción guarda el monto y la moneda originales. DOP/USD se calculan con la tasa del mes y no se persisten.

### API (sugerida)
- `GET /api/months` (lista) · `GET /api/months/:key` (mes completo con fijos, transacciones y envíos) · `PATCH /api/months/:key`
- `POST /api/months/:key/close` → cierra el mes y crea el siguiente (en una transacción D1 `batch`) · `POST /api/months/:key/reopen`
- CRUD: `/api/fixed`, `/api/transactions`, `/api/transfers`, `/api/contributions`, `/api/goals`
- `GET /api/export.xlsx` → genera el libro con `excel-export` (o genéralo en el cliente).
- `POST /api/import` → recibe el .xlsx y hace upsert.

### Registro desde Claude
Hay dos opciones, de menor a mayor esfuerzo:
1. **Endpoint de ingesta**: `POST /api/ingest/transaction` con Bearer, que recibe `{date, description, place, category, method, amount, currency, notes}`. Si el mes no existe, lo crea. Claude llama a este endpoint a través de una herramienta o conector configurado por el usuario.
2. **Servidor MCP remoto** en un Worker (`/mcp`) con estas herramientas:
   - `add_transaction`
   - `list_transactions(month)`
   - `month_summary(month)`
   - `add_transfer`
   - `mark_fixed_paid(name, month)`

   Se agrega como conector personalizado en Claude. Así, en el chat, "gasté 850 en Uber hoy con tarjeta" se convierte en `add_transaction`.

## State Management (frontend)
- Datos del servidor con TanStack Query o similar: meses, mes seleccionado (fijos, transacciones, envíos), metas y aportes.
- Estado local: mes seleccionado (en la URL, `?mes=2026-10`), pestaña (Mes/Ahorros), borradores de las filas de agregar y el modal de cierre.
- Actualizaciones optimistas en las ediciones de celdas, con debounce de ~400ms en los inputs numéricos.

## Design Tokens
- **Colores**:
  - Tinta `#1D1F1C`, texto secundario `#45473F`, muted `#6B6D66`, gris claro `#A9ABA3`
  - Fondo de página `#EFEEE8`, superficie `#FFFEFA`, encabezado de tabla `#F6F5F0`, fila para agregar `#F9F8F3`
  - Bordes `#E3E1D8`, `#EBE9E2`, `#EEECE5`, `#F1EFE9`, punteado `#CFCCC1`
  - Acento `#2F7D52` (hover `#23613F`), oscuro de la dona `#2B3A33`, pendiente `#C9D3C9`, libre `#EBE9E1`
  - Error `#B23A2A`
  - Barra oscura `#1D1F1C`, inputs de la barra `#2B2E29`, borde `#3A3D38`
- **Tipografía**: UI en "Schibsted Grotesk" (400/500/600/700); números en "JetBrains Mono" (400/500/600) con `tabular-nums`.
  - Escala: 11 (labels uppercase), 12–12.5 (meta y celdas numéricas), 13 (cuerpo y tablas), 15 (títulos de tarjeta, 600), 16 (marca), 19/24/28 (cifras).
- **Espaciado**: gaps de 6/8/10/12/14/20px. Padding de tarjeta `14px 16px` y de celda `7px 10px`.
- **Radios**: 3px en botones e inputs, 4px en tarjetas. Sin sombras, excepto el modal (`0 12px 40px rgba(0,0,0,.18)`).

## Assets
Ninguno. No hay imágenes ni íconos; los glifos son texto (‹ › × +).

## Files
- `referencia/Finanzas Personales.html` es el prototipo autocontenido. Se abre en el navegador e incluye datos de ejemplo, importación y exportación de Excel, y el cierre de mes.
- `referencia/excel-export.js` es el generador de .xlsx (expone `window.buildFinanzasXlsx(data)`). La forma de `data` está documentada en `downloadExcel()` del prototipo.
- `referencia/Finanzas Personales v3.xlsx` es el Excel de ejemplo con 3 meses.
- `referencia/Plantilla vacia.xlsx` es la plantilla vacía.

## Datos de ejemplo
Los gastos fijos son: Luz 1,337.15 DOP · Internet 2,699 · Seguro médico 5,640 · Pago nevera 15,000 · Claude 106 USD (día 5) · Google One 121.56 (día 16) · iCloud+ 604 (día 17) · Cluely 308 · Smartfit 1,550 (día 17) · Netflix 1,137.30 · Unicaribe 7,400.

Presupuesto mensual: 70,000 DOP. Tasa Remitly de referencia: 58.76.
