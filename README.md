# FE Finance

App web de finanzas personales para quien cobra y gasta en más de una moneda (DOP, USD y TRY). La usan varias personas (hoy Frank y Eda), cada una con sus finanzas completamente aparte, en su idioma, con sus monedas, sus cuentas y sus colores.

- **Mes**: arriba, el presupuesto (el total en la moneda principal, «≈» en la segunda, la parte que sale de cada cuenta, el sobrante del mes anterior con su botón para sumarlo y, plegado, el historial de cómo fue cambiando), la dona y la lista del presupuesto. Debajo: gastos mensuales fijos (pagado / no pagado), gasto por categoría, las tasas del mes (cada una con su fecha), los envíos entre cuentas y los ingresos del mes, uno al lado del otro (los que se agregan ahí suben además el presupuesto, salvo que se desmarque su casilla) y el historial de transacciones. Cada gasto dice de qué cuenta se paga.
- **Fuera de presupuesto**: bajo el historial, una tarjeta (solo existe cuando el mes tiene alguno; se abre con el enlace de la cabecera del historial) con gastos que le restan a su cuenta como una transacción pero no cuentan en lo usado, lo disponible, las categorías ni el conteo del presupuesto. Cada transacción se puede pasar ahí, y cada uno volver al presupuesto, en una sola llamada. El Excel no los trae como filas, pero sus saldos ya los restan. Si la parte de una cuenta en el presupuesto queda en negativo, el panel lo avisa por escrito («Over budget by …»).
- **Tarjetas de crédito** (pago diferido, varias y opcionales): la tarjeta «Credit cards» de la columna derecha (bajo «Month rates») lista las tarjetas del usuario, de dos en dos con flechas; cada una lleva nombre, banco y últimos 4 dígitos opcionales, moneda, límite, día de corte y día de pago (este puede quedar vacío), un interruptor de activa y un diálogo para crearla o editarla (el diálogo también la elimina, solo si nada la usa). Cada tarjeta ACTIVA tiene una fila fija al pie de los gastos mensuales de cada mes. Lo que se carga a ella (transacciones con método «Credit card» y su selector de tarjeta, y gastos fijos con «Pagar con: <tarjeta>» marcados como pagados) no toca ninguna cuenta ni el presupuesto; el total de la fila = lo que quedó sin pagar del mes anterior en esa tarjeta + «otros cargos» que se escriben en la fila + lo cargado, todo en la moneda de la tarjeta. Su casilla abre el diálogo de pago: se paga todo lo que falta o una parte desde una cuenta de dinero, y puede haber varios pagos en el mes (cada uno con su cuenta y su fecha, tabla `card_payments`; se quitan uno a uno desde el mismo diálogo). Solo entonces cuenta como usado y baja el saldo de esa cuenta. Lo que falta sigue como pendiente del mes y, si el mes se cierra sin pagarlo, pasa al siguiente (se deriva, no se guarda). El desglose por categoría sigue contando lo comprado con tarjeta. Con límite y día de corte, la tarjeta dice cuánto se debe y qué parte es del límite y, en el último mes, cuánto pagar antes del corte para cerrarlo por debajo del 10 % (`cardHint`, shared/calc.ts). Apagar una tarjeta solo se puede si en el último mes no debe nada ni tiene cargos; **limitación conocida**: los cálculos usan las tarjetas activas AHORA en todos los meses (una apagada no suma a ninguno), aunque sus pagos siguen restando de las cuentas. Sin ninguna tarjeta no hay fila ni cifras. El Excel no trae las tarjetas (sus saldos sí restan lo pagado) y al importar se conservan.
- **Cierre de mes**: el mes queda de solo lectura y se crea el siguiente con los mismos gastos fijos sin pagar y su presupuesto inicial: el diálogo de cierre pregunta la parte de cada cuenta (nace con la de este mes) y si se le suma lo que sobró. Un mes también se puede eliminar.
- **Ahorros**: arriba, el dinero total (con el saldo de cada cuenta; ahí se agregan, renombran, ocultan y se les corrige el saldo) y la dona del dinero por cuenta. Debajo: metas, aportes, la tabla de ingreso por mes y los ingresos uno por uno.
- **Excel**: descarga un resumen del histórico del usuario en un `.xlsx` (una hoja por mes + ahorros + Config), en su idioma, y lo vuelve a cargar. El libro conserva el diseño original (USD y DOP, dos cuentas): ver [Excel](#excel).
- **Claude**: un servidor MCP y un endpoint de ingesta para registrar gastos, ingresos y envíos desde un chat («gasté 850 en Uber hoy con tarjeta»).
- **Usuarios y ajustes**: selector de usuario en la barra superior y un panel de ajustes con el idioma (inglés, español o turco), la moneda principal, la segunda moneda, la cuenta por defecto y tres colores. Todo se guarda por usuario.

Se despliega en Cloudflare: **Pages** (frontend), **Pages Functions** (API y MCP) y **D1** (base de datos). El proyecto de Pages se llama `fe-finance`. La especificación de diseño y el prototipo de referencia (de la versión 1, de un solo usuario y en español) están en `design_handoff/`.

## Requisitos

- Node.js 26 y npm (es la versión con la que se desarrolló y probó; las pruebas del servidor usan `node:sqlite`).
- Para desplegar: una cuenta de Cloudflare con Pages y D1. `wrangler` ya viene como dependencia de desarrollo (`npx wrangler`).
- Opcional: LibreOffice (`soffice`). Con él, `shared/excel/export-libreoffice.test.ts` abre los libros generados y recalcula sus fórmulas; sin él, esas pruebas se saltan.

## Desarrollo local

```bash
npm install
cp .dev.vars.example .dev.vars   # token de prueba y utilidades de desarrollo
npm run db:migrate:local         # crea las tablas en la D1 local (.wrangler/state)
npm run dev
```

`npm run dev` levanta dos procesos:

| Puerto | Qué es |
| --- | --- |
| `5173` | Vite: el frontend con recarga en caliente. **Abre http://localhost:5173.** Reenvía `/api` y `/mcp` al puerto 8788. |
| `8788` | `wrangler pages dev`: las Pages Functions (API y MCP) con la D1 local. |

`.dev.vars` define dos variables (los usuarios salen de `wrangler.toml`, ver [Usuarios](#usuarios)):

- `API_TOKEN`: el Bearer de `/api/ingest/*` y `/mcp`.
- `ALLOW_DEV_RESET=1`: activa `/api/dev/*` y muestra, en la barra inferior, «Start blank» y «Restore sample data». **No la definas en producción**: esas rutas borran los datos del usuario.

La primera vez que un usuario entra, la app le crea sus dos cuentas iniciales («US account» en USD y «DR account» en DOP, con saldo 0), sus dos metas iniciales y el mes actual en blanco. Para cargarle los datos de ejemplo (agosto a octubre de 2026) usa el botón «Restore sample data» o:

```bash
curl -X POST -H 'X-User: frank' http://localhost:8788/api/dev/seed
```

**La D1 local de una versión anterior hay que rehacerla una vez.** El esquema (`migrations/0001_init.sql`) se reescribió para el modelo de cuentas y una base ya migrada no se actualiza sola. Si una consulta falla porque falta una tabla o una columna: `rm -rf .wrangler/state/v3/d1 && npm run db:migrate:local`. Los datos locales se pierden (los de ejemplo se restauran con el botón o el `curl` de arriba).

`npm run preview` compila y sirve todo (frontend y API) en http://localhost:8788, igual que en producción.

## Scripts

| Script | Qué hace |
| --- | --- |
| `npm run dev` | Vite (5173) + `wrangler pages dev` (8788). |
| `npm run dev:web` / `npm run dev:api` | Cada mitad por separado. |
| `npm run build` | Typecheck y build de Vite en `dist/`. |
| `npm run preview` | Build y `wrangler pages dev dist` en 8788. |
| `npm run typecheck` | `tsc` sobre los tres proyectos (app, functions, node). |
| `npm test` / `npm run test:watch` | Vitest. |
| `npm run db:migrate:local` / `db:migrate:remote` | Aplica `migrations/` a la D1 local o a la de Cloudflare. |
| `npm run deploy` | Build y `wrangler pages deploy`. |

## Estructura

```
design_handoff/   Especificación (README.md) y prototipo de referencia. No se despliega.
shared/           Código común al navegador, las Functions y las pruebas.
  types.ts          Modelo de dominio.
  api.ts            Contrato HTTP: rutas, cuerpos, errores y reglas de escritura.
  calc.ts           Todos los cálculos (tasas y conversiones, saldos, presupuesto, usado, donas, metas, ingresos).
  users.ts          Lectura de la variable USERS y la cabecera X-User.
  i18n.ts           Idiomas, nombres de los meses y de las categorías y métodos en cada uno.
  theme.ts          Los tres colores de un tema, su validación y los temas listos.
  month.ts, format.ts, constants.ts, seed.ts
  excel/            export*.ts (genera el .xlsx), import*.ts (lo lee), locale-*.ts (sus textos por idioma) y
                    data.ts (el puente entre el modelo de cuentas y la forma del libro).
server/           API y MCP, sin depender de wrangler para poder probarlos.
  app.ts            Rutas HTTP (Hono).
  db.ts             Repositorio sobre D1; lo único que sabe de SQL. Todo va filtrado por usuario.
  users.ts          De quién es cada petición (cabecera o cuerpo).
  validate.ts       Esquemas zod de los cuerpos de petición.
  auth.ts           Bearer y validación del JWT de Cloudflare Access.
  ingest.ts, mcp.ts Registro desde Claude.
  d1-node.ts        Solo pruebas: D1 sobre node:sqlite con las migraciones reales.
functions/        Entradas de Pages Functions: api/[[route]].ts y mcp.ts.
migrations/       Esquema de D1.
src/              Frontend (React 19 + TanStack Query).
  api/client.ts     Cliente HTTP tipado; `api.forUser(id)` manda X-User en cada llamada.
  i18n/             Mecanismo de traducción y textos comunes (en.ts, es.ts, tr.ts).
  theme/            De los tres colores del usuario al resto de la paleta (variables CSS).
  store/            Capa de datos (una por usuario): escrituras optimistas, estado en la URL, flujos.
  ui/               Celdas y tablas tipo hoja de cálculo, diálogo y campos de formulario.
  components/       Barra superior, ajustes, paneles resumen (presupuesto y dinero total), modales de cerrar y
                    eliminar mes, pestañas, avisos.
  screens/          mes/ y ahorros/, cada una con sus textos en strings.ts.
tests/            El exportador original del prototipo (para compararlo con el port) y dos entradas congeladas
                  del generador de Excel (export-data-es.json y export-data-en.json).
```

## Usuarios

Cada persona tiene sus finanzas aparte: sus cuentas, meses, ingresos, metas, aportes y ajustes. No hay registro ni tabla de usuarios; la lista sale de la variable de entorno `USERS`, definida en `wrangler.toml`:

```toml
[vars]
USERS = "frank:Frank,eda:Eda"
```

- Son pares `id:Nombre` separados por comas (máximo 12). El primero es el que se abre por defecto.
- **Agregar a alguien**: añade su par y vuelve a desplegar. La primera vez que entre tendrá las dos cuentas y las dos metas iniciales («Emergency fund» y «Personal savings») y el mes actual.
- **Renombrar**: cambia solo el nombre (lo que va después de los dos puntos).
- **El id no se cambia nunca**: es la clave de sus datos en la base (`user_id`). Si cambia, esa persona aparece vacía y sus datos quedan huérfanos. Solo admite minúsculas, dígitos, `-` y `_`.
- Quitar a alguien de la lista no borra sus datos; dejan de verse.
- Sin `USERS`, la app funciona con un solo usuario (`me`).

El selector de la barra superior cambia de usuario (y con él los datos, el idioma, las monedas y los colores); con un solo usuario no se muestra. Es un cambio de perfil, **no un control de acceso**: quien pasa Cloudflare Access puede ver a cualquiera de los usuarios. La URL recuerda dónde estás: `?user=eda&month=2026-10&sheet=savings` (la hoja del mes es la de por defecto y no se escribe).

## Idiomas

La interfaz está en inglés (por defecto), español y turco. Cada usuario elige el suyo en «Settings» y se guarda en el servidor; el Excel que descarga sale en ese idioma.

- **Dónde están los textos.** Los comunes, en `src/i18n/en.ts`, `es.ts` y `tr.ts`; los de cada pantalla, en `src/screens/mes/strings.ts` y `src/screens/ahorros/strings.ts`; los del libro de Excel, en `shared/excel/locale-en.ts`, `locale-es.ts` y `locale-tr.ts`. Los nombres de los meses, las categorías y los métodos, en `shared/i18n.ts`.
- **Lo guardado no depende del idioma.** Categorías y métodos de pago se guardan con su nombre canónico en inglés (`CATS` y `METHODS` en `shared/constants.ts`) y se traducen solo al mostrarlos; un valor fuera de la lista se muestra tal cual. Lo que escribe el usuario (descripciones, lugares, notas, nombres de gastos, de cuentas y de metas) no se traduce nunca. Los códigos de moneda (DOP, USD, TRY) se muestran igual en los tres idiomas.
- **La API responde siempre en inglés.** La web traduce los errores por su código (`error.code`) y deja el mensaje del servidor como detalle. El servidor MCP también es solo en inglés: Claude habla con cada persona en su idioma.
- Los números tienen el mismo formato en los tres idiomas (`42,025.57`).
- **El turco está pendiente de revisión por un hablante nativo.** Si cambia el nombre de una columna en `locale-tr.ts`, los libros en turco exportados antes solo se leerán si sus tablas están en las filas originales.

**Agregar un idioma.** Añádelo al tipo `Language` (`shared/types.ts`) y a `shared/i18n.ts` (`LANGUAGES`, `isLanguage`, meses, categorías y métodos). A partir de ahí el compilador señala cada diccionario que falta: `src/i18n/<idioma>.ts` (y su entrada en `src/i18n/core.ts`), los `strings.ts` de las dos pantallas y `shared/excel/locale-<idioma>.ts` (y su entrada en `EXCEL_LOCALES`). Los diccionarios se tipan con la forma del inglés, así que una clave que falte o sobre no compila.

## Colores

En «Settings → Appearance» cada usuario elige tres colores: acento (botones, foco, barras), barra superior y fondo. Hay siete temas listos y un botón «Reset to default». El resto de la paleta (hover, texto legible sobre cada color, tonos de la dona, pestañas) se deriva en `src/theme/derive.ts` y se aplica como variables CSS. Sin tema guardado (`theme: null`) no se sustituye nada y la app se ve con la paleta original del diseño.

## Modelo de datos y cálculos

D1 es la fuente de verdad. Tablas (`migrations/0001_init.sql`, `0002_dated_rates_budget_log.sql`, `0004_transfer_budget.sql`, que añade `transfers.budget`, `0005_gold_accounts.sql`, que rehace `accounts` e `incomes` para admitir el oro sin tocar una fila, `0006_transfer_fee.sql`, que añade `transfers.fee`, y `0008_outside_expenses.sql`, que crea `outside_expenses`; `0009` y `0010` añaden la tarjeta de crédito y sus pagos, y `0011_credit_cards.sql` la generaliza a varias tarjetas: crea `credit_cards` y `month_cards`, añade `card_id` a `card_payments`, `fixed_expenses` y `transactions`, y a cada usuario con datos de tarjeta le crea la tarjeta «Credit card» con todo lo suyo, sin cambiar ninguna cifra; `months.card_other/card_paid/card_account_id` quedan sin usar): `months`, `accounts`, `month_budget_log`, `month_rates`, `fixed_expenses`, `transactions`, `outside_expenses`, `credit_cards`, `month_cards`, `card_payments`, `transfers`, `incomes`, `goals`, `contributions` y `settings`. Todas llevan `user_id` y todas las claves son `(user_id, …)`, de modo que dos usuarios pueden tener el mismo mes o los mismos ids sin tocarse.

### El dinero

- **Tres monedas**: DOP, USD y TRY. Cada fila guarda su **monto y su moneda originales**; nada convertido se guarda nunca, ni tampoco los saldos.
- **Moneda principal y segunda moneda**, por usuario («Settings → Currencies»). En la principal se ven el presupuesto, los totales y la primera columna de importes de cada tabla; en la segunda, las líneas «≈» y la segunda columna. Tienen que ser distintas; al cambiarlas, todas las cifras y los encabezados las siguen. Un usuario nuevo empieza con DOP y USD.
- **Cuentas**, de cada usuario: un nombre y una moneda. Se agregan, se renombran y se ocultan en «Savings». Una cuenta oculta no aparece en las listas ni suma al dinero total, pero conserva sus movimientos. Una cuenta con movimientos no se elimina ni cambia de moneda (se oculta), y siempre queda al menos una.
- **Oro.** Una cuenta puede estar también en oro (`XAU`), medido en gramos («125.50 g», hasta tres decimales). El oro solo existe ahí, en «Savings»: no es moneda principal ni segunda, ni de metas, tasas, gastos o transacciones, y una cuenta de oro no se puede elegir (la API y el MCP la rechazan con `400`) para una parte del presupuesto, un gasto fijo, una transacción, un envío ni como cuenta por defecto; en la hoja del mes no aparece. Su saldo es el saldo inicial más los ingresos que se le registran en «Savings», que son gramos y nunca suben el presupuesto ni cuentan como ingreso del mes. Lo que vale lo dice el **precio del oro**: el valor de 1 gramo en la moneda que se elija, escrito a mano junto a las cuentas (un ajuste por usuario; no hay precio por defecto). Con precio, los gramos pasan a esa moneda y de ahí a la principal con las tasas de siempre, y suman al dinero total; sin precio, la cuenta se ve solo en gramos y el total avisa de que el oro no está incluido.
- **Saldos calculados.** El saldo de una cuenta no se escribe mes a mes: es su saldo inicial, más los ingresos que le entran, menos las transacciones y los gastos fijos **pagados** que salen de ella, menos los envíos que salen y más los que entran, todo hasta el mes que se mira. Un movimiento en otra moneda entra o sale convertido con la tasa vigente en su fecha (un gasto fijo, que no tiene fecha, con la última de su mes). «Corregir» un saldo a mano (escribiéndolo en «Savings», solo en el último mes) ajusta el saldo inicial; los movimientos no se tocan. Los aportes a metas son un apartado y no mueven saldos.
- **Cuenta por defecto**: de ella sale un gasto cuando no se indica otra (también los que registra Claude). Es la elegida en «Settings»; si no hay, la primera visible en la moneda principal.
- **Tasa propia (migración 0007).** Un ingreso y un aporte pueden llevar su `rate` (moneda principal por 1 de su moneda; `null` = la vigente en su fecha). Solo gobierna la conversión a la moneda principal (columna principal, totales, «Income by month», lo ahorrado de una meta); saldos, presupuesto y la conversión a la moneda de la meta siguen con la tasa de la fecha. Un ingreso puede ser `recurring`: al crearse un mes nuevo, `server/db.ts recurringIncomesStatement` copia los del mes registrado anterior (mismo día recortado, tasa automática, sin duplicar uno igual que ya exista). Un aporte puede decir la cuenta de dinero de la que sale (`accountId`) y le resta a su saldo.
- **Ingresos**, uno por uno: fecha, descripción, cuenta, monto y moneda. El ingreso de un mes es la suma de los que tienen fecha en él; ya no se escribe. No pertenecen a un mes: se agregan y editan aunque el mes esté cerrado.
- **Envíos** entre dos cuentas distintas: lo que sale (en la moneda de la cuenta de origen) y la tasa; a la de destino le entra `monto × tasa`. Entre cuentas de la misma moneda la tasa es 1. La vía es texto libre; Remitly y PayPal son solo sugerencias. Un envío puede llevar **comisión** (`fee`, >= 0), en la moneda de la cuenta de origen y nunca convertida para el saldo: le resta a esa cuenta y cuenta como una transacción más del mes (en «Other», en lo usado y en el historial de transacciones, como una fila de solo lectura que sale del envío). No se guarda como transacción: se cambia en el envío. En la fila de agregar, la comisión arranca en la del último envío por esa misma vía.
- **Presupuesto por cuenta, con historia.** El presupuesto del mes se reparte por la cuenta de la que sale, cada parte en la moneda de su cuenta; el total es la suma convertida a la moneda principal. Son planes, no saldos. No es un número que se sobrescribe: es la suma de un registro de movimientos con fecha (`month_budget_log`: el inicial, los ajustes y el sobrante), así queda cómo fue cambiando. Fijar la parte de una cuenta añade al registro la diferencia.
- **Ingresos que suben el presupuesto y envíos que lo mueven.** Un ingreso marcado con `budget` («Adds to budget») suma además al presupuesto del mes de su fecha, en la parte de su cuenta (convertido a la moneda de la cuenta con la tasa de su fecha). Un envío marcado con `budget` («Moves budget») **mueve** presupuesto dentro de su mes: le resta a la parte de la cuenta de origen lo que sale (`monto`) y le suma a la de destino lo que le entra (`monto × tasa`); con la tasa del mes, el total no cambia. Una parte puede quedar en negativo, y la cuenta de origen sale como parte aunque no tenga registro. Los saldos se mueven igual que sin la marca. Ninguno escribe nada en el registro: lo hace el cálculo, y en el historial del presupuesto un envío sale en dos filas (lo que sale de una cuenta y lo que entra a la otra). Fijar la parte de una cuenta fija lo que suma su registro; lo que ponen ingresos y envíos va aparte. (Hasta la migración 0006 un envío marcado solo sumaba en la cuenta de destino; los marcados entonces tienen ya el significado nuevo.)
- **Sobrante.** Lo que sobra de un mes es su disponible (presupuesto − usado). Se puede sumar al mes siguiente, una sola vez, como un movimiento del registro en la cuenta por defecto; si el mes se pasó, resta. Al cerrar un mes se eligen las partes iniciales del siguiente y si se le suma el sobrante.
- **Tasas con fecha**, por par de monedas y escritas a mano (tarjeta «Month rates»). Cada una vale desde su fecha hasta la siguiente que se escriba para ese par, también en los meses siguientes, y un mes puede tener varias. Cada fila con fecha propia (transacción, ingreso, aporte, envío sin tasa) se convierte con la vigente en **su** fecha: escribir hoy una tasa nueva no cambia lo registrado antes. Lo que es del mes entero (gastos fijos, presupuesto, totales, saldos «al final del mes») usa la última del mes. Una tasa se resuelve en este orden y la interfaz dice de dónde salió:
  1. la última escrita para el par con fecha anterior o igual a la de la fila (o su inversa), sea de ese mes o de uno anterior;
  2. si no hay ninguna vigente, el promedio ponderado de los envíos de ese mes entre esas dos monedas;
  3. cruzando por la tercera moneda (cada tramo, la escrita vigente o los envíos de ese mes);
  4. lo mismo, en el mes anterior más reciente que lo tenga;
  5. un valor fijo de respaldo (1 USD = 58.76 DOP = 42 TRY). Es un número de referencia, no el del mercado: la barra superior y la tarjeta de tasas lo avisan («default value, not set yet») y conviene escribir la tasa.

  Un envío guardado sin tasa toma la vigente en su fecha en ese momento; a partir de ahí cuenta como envío del mes (paso 2).
- **Metas en su moneda.** Cada meta tiene la suya: en ella van el ahorro mensual, el objetivo y lo ahorrado. Cada aporte guarda su moneda y se convierte a la de la meta con la tasa vigente en su fecha. Cada meta puede elegir además en qué moneda se muestra su línea «≈» (por defecto, la principal).
- **Mes cerrado = solo lectura.** La API responde `409 month_closed` a cualquier escritura en sus gastos, transacciones, envíos, presupuesto o tasas. Se puede reabrir y eliminar.
- **Eliminar un mes** («Delete month», al final de la hoja; abierto o cerrado) borra sus gastos fijos, transacciones, envíos, presupuesto y tasas, y no se puede deshacer. Los saldos cambian en consecuencia. Los ingresos y los aportes con fecha en ese mes se conservan (no son del mes). Si era el único mes, al volver a entrar se crea el actual.
- **Ajustes por usuario** (`settings`): idioma, tema, moneda principal, segunda moneda, cuenta por defecto, precio del oro, tasa USD→DOP de respaldo y la marca de que ya se le crearon las cuentas y metas iniciales (si las borra, no vuelven).
- «Hoy» se calcula siempre en `America/Santo_Domingo`.

Todos los cálculos están en `shared/calc.ts` (con `shared/calc.test.ts` como documentación ejecutable) y los usan por igual el frontend, la API, el MCP y el puente del Excel. El formato de números está en `shared/format.ts`. El frontend carga el histórico completo del usuario con `GET /api/state` y aplica las ediciones de forma optimista; las de texto y número esperan 400 ms antes de enviarse. Cada usuario tiene su propia cola de guardado: lo que quedó pendiente de uno se envía con su cabecera aunque ya se esté viendo a otro.

### Metas

En «Savings», cada tarjeta tiene «Edit» y al final está «Add goal». Una meta es de dos tipos:

- **Sin plan** (aportes variables): solo acumula lo que se le aporta.
- **Con plan**: ahorro mensual (en la moneda de la meta), mes de inicio y mes objetivo, los tres juntos. El monto objetivo no se guarda: es `ahorro mensual × meses`, contando los dos extremos. En el formulario se escribe el objetivo o el mensual y el otro se calcula.

La moneda de la meta se elige en el formulario (por defecto, la principal); si se cambia después, los montos escritos se quedan como están y lo ahorrado se vuelve a convertir. Los aportes se editan en su fila (fecha, meta, monto y moneda). Una meta con aportes no se puede eliminar hasta borrar o mover sus aportes. Los nombres no se repiten dentro de un usuario (sin distinguir mayúsculas) y no se traducen.

## API

El contrato completo (rutas, cuerpos y reglas) está en el comentario inicial de `shared/api.ts`.

- **`X-User: <id>`** es obligatoria en todas las rutas de `/api/*` salvo `/api/session` y `/api/ingest/*`. Si falta o no es un usuario configurado: `400 validation`. Todo lo que la ruta lee o escribe es de ese usuario; un id que existe pero es de otro responde `404`.
- **`GET /api/session`** (sin `X-User`): los usuarios configurados y si están activas las utilidades de desarrollo. Es lo primero que pide la web.
- **`GET /api/state`**: `{ user, state }` con todo el histórico del usuario (meses, cuentas, ingresos, metas, aportes) y sus ajustes. La primera vez le crea las cuentas y metas iniciales y el mes actual.
- **`PATCH /api/settings`**: cualquier combinación de `language`, `theme` (`null` vuelve a la paleta original), `mainCurrency`, `secondCurrency`, `defaultAccountId` (`null` = automática; no puede ser una cuenta de oro) y `goldPrice` (`{ "amount", "currency" }`, lo que vale 1 gramo de oro; `null` lo quita). Las dos monedas deben quedar distintas: para intercambiarlas se mandan juntas.
- **`/api/accounts`** (`GET`, `POST`, `PATCH /:id`, `DELETE /:id`): cuentas. `PATCH` cambia nombre, saldo inicial, `hidden` u orden. Eliminar una cuenta en uso (o la última) y cambiar la moneda de una cuenta en uso responden `409 conflict`.
- **`PATCH /api/months/:key`**: `{ "budgets": { "<cuenta>": monto } }`, las partes del presupuesto que cambian (>= 0; 0 quita la parte).
- **`PUT /api/months/:key/rates`** `{ "from", "to", "rate" }` escribe la tasa de un par (una por par, en cualquier sentido) y **`DELETE /api/months/:key/rates/:from/:to`** la quita.
- **`DELETE /api/months/:key`**: elimina el mes con todo lo suyo.
- **`/api/incomes`** (`GET`, `POST`, `PATCH /:id`, `DELETE /:id`): ingresos. A una cuenta de oro le entran gramos: `cur` tiene que ser `XAU` (y solo ahí) y `budget` no puede ser `true`.
- Una cuenta de oro (`currency: "XAU"`) en un cuerpo que es de dinero (presupuesto, gasto fijo, transacción, envío, cuenta por defecto) responde `400 validation` (`"<nombre>" is a gold account (grams): …`).
- **`/api/fixed`**, **`/api/transactions`**: llevan `accountId` (si falta al crear, la cuenta por defecto). **`/api/transfers`**: `fromAccountId`, `toAccountId`, `amount` y `rate` opcional (si falta, la del mes para ese par). Envíos y aportes (**`/api/contributions`**) también se editan con `PATCH`.
- **`/api/goals`**: crear, editar y eliminar metas, con su moneda (`cur`; por defecto la principal). Un plan a medias responde `400`; un nombre repetido o eliminar una meta con aportes, `409 conflict`.
- Una cuenta que no existe, en cualquier cuerpo, responde `400 validation` (`Unknown account "<id>".`).
- Los errores tienen siempre la forma `{ "error": { "code", "message" } }`, con el mensaje en inglés.

## Excel

**El libro es un resumen, no una copia.** Conserva el diseño original, que solo conoce dos monedas (USD y DOP) y dos cuentas, con el presupuesto, el ingreso y los saldos escritos mes a mes. Rediseñarlo queda pendiente. Entre el modelo de cuentas y esa forma media un puente (`shared/excel/data.ts`, con las reglas completas en sus comentarios).

**Exportar.** «Download Excel», y «Yes, add to Excel» al cerrar un mes, generan `FE Finance - <usuario>.xlsx` en el navegador con el estado que tiene el servidor en ese momento, en el idioma del usuario: nombres de las hojas («October 2026», «Octubre 2026», «Ekim 2026»; «Savings», «Ahorros», «Birikimler»), encabezados, categorías y métodos. La hoja de ahorros dibuja una tarjeta por meta, en bandas (hasta dos metas sin plan y una con plan en cada una), y baja las tablas según haga falta. Por cada mes, con las tasas de ese mes:

- el presupuesto es el total, en DOP; el ingreso, el total del mes, en USD;
- los dos saldos son la suma de las cuentas visibles en DOP y la suma de las demás (USD y TRY), en USD;
- gastos y transacciones en TRY salen convertidos a DOP (la transacción lleva el monto original en sus notas); aportes en TRY, a USD; el ahorro mensual de una meta en otra moneda, a USD;
- solo salen los envíos entre una cuenta en USD y otra en DOP;
- las comisiones de los envíos no salen como filas (el libro no las conoce), aunque ya están restadas en los saldos; al importar, un envío que coincide con uno que el mes ya tenía conserva su comisión y su marca `budget`;
- las cuentas de oro no salen: ni sus gramos ni su valor entran en los saldos del libro, y sus ingresos en gramos no son ingreso del mes. Al importar, las cuentas de oro, sus ingresos y el precio del oro quedan como estaban.

Se pierde: qué cuenta pagó cada gasto y el saldo de cada una, el reparto del presupuesto, el detalle de los ingresos, las tasas escritas a mano (el libro calcula la suya con los envíos del mes; si la escrita era otra, lo que muestra convertido difiere de la app), los envíos de otros pares y la moneda de las metas. No depende de la moneda principal del usuario.

El generador (`shared/excel/export.ts`) es un port de `design_handoff/referencia/excel-export.js`. En español y con las tres metas del diseño produce los mismos bytes que el original: con `tests/export-data-es.json` sale exactamente `Finanzas Personales v3.xlsx`.

**Importar.** «Import Excel» lee el archivo en el navegador (`shared/excel/import.ts`, sin SheetJS) y manda su contenido a `POST /api/import`:

- Reconoce las hojas de mes y la de ahorros en cualquiera de los tres idiomas (también mezclados), y devuelve las categorías y los métodos con su nombre canónico.
- Cada mes del archivo **sustituye por completo** al que hubiera con esa clave. Los meses que no vienen en el archivo no se tocan.
- Todos los meses del archivo quedan cerrados salvo el último.
- Las dos cuentas del libro son la primera cuenta visible del usuario en USD y la primera en DOP (la que falte se crea). Lo que está en USD se paga desde la primera y el resto desde la segunda; cada envío va de la de USD a la de DOP; todo el presupuesto queda en la de DOP. El mes importado queda **sin tasas escritas** y sin el reparto que tuviera.
- El ingreso del mes del libro es el total del mes: lo que le falte a lo que el usuario ya tiene registrado en ese mes entra como un ingreso «Income (imported)» en USD el día 1. Volver a cargar el propio libro no duplica ingresos.
- Saldos: se ajusta el saldo inicial de esas dos cuentas para que, al final del **último** mes importado, las cuentas visibles sumen lo que dice el libro. Los saldos que el libro trae para meses anteriores no se usan (en la app salen de los movimientos).
- Si trae la hoja de ahorros, sus aportes sustituyen a **todos** los existentes. Las metas se leen de las tarjetas (en el orden de la hoja Config), se buscan por nombre y se crean si faltan, en USD; a las que ya existen se les pone el plan del archivo (y pasan a USD, la moneda del libro), y las que no vienen en el archivo se conservan.
- **Libros de la versión 1** (en español, con sus tres metas fijas): se leen igual. Sus metas pasan a llamarse como las de hoy («Fondo de emergencia» → «Emergency fund», «Ahorro personal» → «Personal savings», «Viaje a Turquía» → «Trip to Turkey»), para que los aportes caigan en las metas iniciales en vez de duplicarlas. Quien conserve una meta con el nombre de entonces la sigue usando.
- Una fecha que no se puede leer se toma como el día 1 del mes de su hoja.
- Un monto negativo o un texto demasiado largo rechazan el archivo entero. El aviso señala el dato, por ejemplo `months.2.tx.3.amount: cannot be negative` (tercer mes del archivo, cuarta transacción).
- El idioma, las monedas y los colores no viajan en el libro: se puede cargar el libro de otra persona, o uno en otro idioma, sin que cambien.
- **Cuidado al recargar el propio libro con datos que el libro no lleva** (TRY, más de dos cuentas, tasas escritas): los meses que trae vuelven resumidos a dos cuentas y sin sus tasas. Los totales en los términos del libro se conservan; el detalle no.

Las dos operaciones también existen como rutas, para usarlas sin la web:

```bash
curl -H 'X-User: frank' -o finanzas.xlsx http://localhost:8788/api/export.xlsx
curl -X POST --data-binary @finanzas.xlsx -H 'X-User: frank' \
  -H 'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' \
  http://localhost:8788/api/import
```

## Despliegue en Cloudflare Pages

El proyecto de Pages se llama **`fe-finance`** (el `name` de `wrangler.toml`) y la base D1, `finanzas`.

1. **Sesión de wrangler.** `npx wrangler login`, o define `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` en un archivo `.env` (está en `.gitignore`).
2. **Base D1.** Ya está creada y su id está en `wrangler.toml` (`database_id`; es un identificador, no un secreto). Para empezar en otra cuenta: `npx wrangler d1 create finanzas` y pega ahí el id que devuelve.
3. **Aplicar las migraciones** en Cloudflare:
   ```bash
   npm run db:migrate:remote
   ```
   El esquema se reescribió dentro de la misma migración (`0001_init.sql`: cuentas, ingresos, presupuesto por cuenta, tasas por mes). Una D1 que ya tuviera aplicada una versión anterior no se actualiza sola: descarga antes el Excel con la versión que la creó, borra sus tablas (incluida `d1_migrations`) o crea una base nueva, aplica la migración y vuelve a cargar el Excel (llega como resumen: ver [Excel](#excel)).
4. **Proyecto de Pages** (solo la primera vez):
   ```bash
   npx wrangler pages project create fe-finance --production-branch main
   ```
5. **Usuarios.** Revisa `USERS` en `wrangler.toml` ([Usuarios](#usuarios)).
6. **Secrets del proyecto.** No van en `wrangler.toml`:
   ```bash
   openssl rand -hex 32               # genera un token
   npx wrangler pages secret put API_TOKEN --project-name fe-finance
   npx wrangler pages secret put ACCESS_TEAM_DOMAIN --project-name fe-finance
   npx wrangler pages secret put ACCESS_AUD --project-name fe-finance
   ```
   `API_TOKEN` es el Bearer que usará Claude; sin él, `/api/ingest/*` y `/mcp` responden siempre 401. Los otros dos se explican en [Autenticación](#autenticación).
7. **Desplegar.** Sube `dist/` y las Functions con el binding de D1 y las variables de `wrangler.toml`:
   ```bash
   npm run deploy
   ```
   Un secret o una variable que cambies después solo se aplica al siguiente despliegue.
8. **Cloudflare Access delante** antes de usar la app (siguiente sección). Sin Access la API queda abierta a cualquiera que tenga la URL.

## Autenticación

La app no tiene login propio. Quién puede **entrar** lo decide Cloudflare Access (por correo); de **quién** son los datos que se ven lo decide el selector de usuario, que no es un control de acceso.

**Aplicaciones de Access.** El despliegue usa tres, en Zero Trust → Access → Applications:

| Aplicación | Qué cubre | Política |
| --- | --- | --- |
| El sitio | `fe-finance.pages.dev` (y el dominio propio, si lo hay) | *Allow* para los correos de quienes usan la app |
| Vistas previas | `*.fe-finance.pages.dev` (cada despliegue tiene además su propia URL) | *Allow* para los mismos correos |
| Claude | `fe-finance.pages.dev/mcp` y `fe-finance.pages.dev/api/ingest/*` | *Bypass* |

La tercera existe porque Claude no puede iniciar sesión en Access: `/mcp` y `/api/ingest/*` exigen `Authorization: Bearer <API_TOKEN>` y tienen que quedar fuera de él. Al ser más específica que la del sitio, tiene prioridad. (La alternativa a *Bypass* es una política *Service Auth* con un service token, que el cliente debe enviar en `CF-Access-Client-Id` y `CF-Access-Client-Secret` además del Bearer.)

**Validación del JWT de Access.** Con `ACCESS_TEAM_DOMAIN` (`<equipo>.cloudflareaccess.com`) y `ACCESS_AUD` (el *Application Audience (AUD) Tag* de la aplicación del sitio) definidas, la API comprueba en cada petición a `/api/*` el JWT que añade Access (`Cf-Access-Jwt-Assertion`) y rechaza con 401 o 403 lo que no haya pasado por él. Así la API sigue cerrada aunque algún nombre de host quede fuera de Access.

Las dos se definen como **secrets del proyecto de Pages, solo en producción**, y no en `[vars]` de `wrangler.toml`. El motivo: lo que está en `wrangler.toml` vale también para `wrangler pages dev` y para las vistas previas. En local no hay Access que ponga el JWT, así que la API rechazaría todas las peticiones; y las vistas previas pasan por otra aplicación de Access, con otro AUD. Como secrets de producción solo existen donde hay un JWT que validar.

Definir solo una de las dos hace que la API responda 500. Sin ninguna, la API confía en que Access está delante (es el modo del desarrollo local y de las vistas previas).

El token Bearer solo sirve en `/mcp` y `/api/ingest/*`; no abre el resto de la API. Además, la API rechaza con 403 las escrituras que un navegador marca como venidas de otro sitio (`Sec-Fetch-Site: cross-site`).

## Conectar Claude

### Servidor MCP

`https://<host>/mcp` es un servidor MCP remoto (Streamable HTTP, sin sesiones, solo `POST`) que exige `Authorization: Bearer <API_TOKEN>` en cada petición. Se identifica como `fe-finance` y responde solo en inglés. Herramientas:

| Herramienta | Argumentos | Qué hace |
| --- | --- | --- |
| `add_transaction` | `user`, `description`, `amount`; opcionales `currency` (DOP, USD, TRY), `account`, `date`, `place`, `category`, `method`, `notes` | Registra un gasto. Por defecto: la cuenta por defecto y su moneda, hoy, Food, Debit card. Responde con el saldo nuevo de la cuenta. |
| `list_transactions` | `user`; opcionales `month`, `limit` | Transacciones del mes, de la más reciente a la más antigua, con su cuenta. |
| `month_summary` | `user`; opcional `month` | En la moneda principal: presupuesto y sus partes por cuenta, usado, disponible, fijos pendientes, gasto por categoría, ingreso del mes, saldos y las tasas del mes con su origen. |
| `add_transfer` | `user`, `from_account`, `to_account`, `amount`; opcionales `rate`, `via`, `date`, `fee`, `move_budget` (o `add_to_budget`, su nombre de antes) | Registra un envío entre dos cuentas. Sin `rate` usa la del mes y dice de dónde salió (si es el valor de respaldo, avisa). `fee` es la comisión, en la moneda de la cuenta de origen. Con `move_budget: true` el presupuesto del mes pasa de la parte de la cuenta de origen a la de destino. |
| `mark_fixed_paid` | `user`, `name`; opcionales `month`, `paid` | Marca un gasto fijo como pagado, buscándolo por nombre; dice de qué cuenta sale. |
| `add_income` | `user`, `amount`; opcionales `currency`, `account`, `date`, `description` | Registra un ingreso en una cuenta. No lo bloquea un mes cerrado. En una cuenta de oro, `amount` son gramos (sin `currency` ni `add_to_budget`). |
| `list_accounts` | `user` | Cuentas visibles con moneda y saldo, cuál es la de por defecto y el dinero total en las dos monedas. Las de oro, en gramos, con el precio del oro y si quedan fuera del total por no tenerlo. |
| `pay_credit_card` | `user`, `amount`; opcionales `card` (nombre o id; por defecto la primera activa), `account`, `month` | Añade un pago de una tarjeta de crédito (en su moneda, como mucho lo que falta): sale de la cuenta y cuenta como usado. `add_transaction` con método «Credit card» acepta también `card`. |
| `list_credit_cards` | `user` | Las tarjetas con moneda, límite, corte, día de pago, si están activas, lo que se debe y, con límite y corte, cuánto pagar antes del corte para quedar por debajo del 10 %. `month_summary` trae lo mismo de cada tarjeta. |

Las cuentas se dicen por su nombre (sin distinguir mayúsculas ni acentos; vale un comienzo que no sea ambiguo) o por su id. Desde el MCP no se crean cuentas, tasas ni presupuesto, ni se cambian ajustes (tampoco el precio del oro), ni se editan o borran registros: eso se hace en la web. Una cuenta de oro no vale para `add_transaction` ni `add_transfer`.

**`user`** es el id de la persona (`frank`, `eda`) y es obligatorio cuando hay más de un usuario configurado; con uno solo se puede omitir. Si falta o no existe, la herramienta responde con un error que lista los usuarios válidos y no registra nada. Al modelo se le indica que pregunte cuando no esté claro de quién son las finanzas, así que conviene que cada persona lo deje dicho en las instrucciones de su proyecto de Claude («mi usuario de FE Finance es `eda`»). Cada respuesta nombra a la persona («Recorded for Eda: …»).

En **Claude Code**:

```bash
claude mcp add --transport http fe-finance https://<host>/mcp \
  --header "Authorization: Bearer <API_TOKEN>"
```

En local la URL es `http://localhost:8788/mcp` y el token, el de `.dev.vars`.

En **claude.ai** (conector personalizado) hace falta enviar esa misma cabecera. Según la documentación de conectores de Claude, las cabeceras fijas están en beta para un grupo limitado de organizaciones: si al agregar el conector no aparece la sección «Request headers», no se puede conectar, porque este servidor no implementa OAuth.

Reglas propias del MCP: la categoría y el método tienen que ser de las listas de la app, dichos en inglés, español o turco («Transporte», «Kredi kartı»), y se guardan con el nombre en inglés («tarjeta», «card» o «kart» a secas es la de débito, `Debit card`); la vía de un envío es texto libre; una fecha solo se acepta si su mes existe o está entre 6 meses atrás y 1 adelante de hoy; un mes cerrado no admite gastos ni envíos; entre cuentas de la misma moneda un envío no lleva tasa. Los saldos que responde son «a hoy»: al final del último mes registrado (o del mes actual, o del mes recién escrito, el que sea posterior).

### Endpoint de ingesta

La alternativa sin MCP es una sola petición. Solo `description` y `amount` son obligatorios (y `user` si hay más de un usuario); el mes de la fecha se crea si no existe:

```bash
curl -X POST https://<host>/api/ingest/transaction \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"user":"frank","description":"Uber","amount":850,"category":"Transporte","method":"Tarjeta"}'
```

Campos: `user`, `date` (AAAA-MM-DD, por defecto hoy), `description`, `place`, `category` (por defecto Food), `method` (por defecto Debit card; «Tarjeta», «Card» o «Kart» a secas se guarda como Debit card), `amount`, `account` (id o nombre; por defecto la cuenta por defecto), `currency` (por defecto la de esa cuenta) y `notes`. La categoría y el método se aceptan en los tres idiomas y se guardan con su nombre en inglés; lo que no es de las listas se guarda tal cual. Responde `201` con la transacción, `400` si falta el usuario o no existe (o la cuenta no existe o es ambigua), `401` sin token válido y `409` si el mes está cerrado.

## Pruebas

`npm test` corre unas 1,600 pruebas con Vitest, todas en Node:

- Los cálculos (`shared/calc.test.ts`) y el puente del Excel (`shared/excel/data.test.ts`) se prueban con cifras hechas a mano.
- El generador de Excel se compara byte a byte con el script original y con los dos libros de `design_handoff/referencia/` (en español, con las tres metas del diseño). Los libros en inglés y en turco y los de varias bandas de metas se comprueban por estructura y, si hay LibreOffice, recalculando sus fórmulas.
- El lector de Excel se prueba con libros en los tres idiomas, con libros de la versión 1 y con libros guardados por LibreOffice.
- La API, el repositorio y el MCP corren contra una D1 en memoria (`server/d1-node.ts`) con las migraciones reales y siempre con dos usuarios, comprobando que lo de uno no toca lo del otro. `server/e2e.test.ts` y `server/e2e-users.test.ts` encadenan API, Excel y MCP sin sustituir nada, y `server/e2e-money.test.ts` registra un mes guionizado (tres monedas, cuatro cuentas, envíos en los dos sentidos) por la API y por el MCP y comprueba saldos, presupuesto, usado e ingreso contra cuentas hechas a mano.
- El frontend prueba la capa de datos, los diccionarios (mismas claves y parámetros en los tres idiomas), la derivación de colores, las funciones puras y el HTML que renderizan las pantallas. No hay pruebas con DOM; la interacción se revisó a mano en el navegador.

## Limitaciones conocidas

- **El Excel sigue con el diseño de la versión 1** (USD y DOP, dos cuentas): es un resumen del modelo de cuentas y pierde detalle en los dos sentidos ([Excel](#excel)).
- **Las tasas se escriben a mano**; la app no consulta ninguna fuente. Sin tasa para un par se usa un valor fijo de respaldo, marcado como tal. En «Month» el aviso está en la tarjeta de tasas y en la barra superior, no en cada cifra; en «Savings», en cada cifra convertida.
- **Solo se corrige el saldo en el último mes**, y siempre ajustando el saldo inicial: los saldos de los meses anteriores se mueven con él.
- **Una importación reescribe todos los datos del usuario en un solo lote**: una escritura que llegue a la vez (por ejemplo, un gasto desde Claude) puede perderse.
- **Esta versión se probó en local** con `wrangler pages dev` (workerd y D1 locales), no contra la D1 remota ni detrás de Access.
- **El turco está sin revisar** por un hablante nativo. En el libro de Excel, el rótulo en mayúsculas del mes puede salir sin el punto de la İ («EKIM 2026») en un sistema que no esté en turco; y una categoría escrita toda en mayúsculas con İ («EĞİTİM») no se reconoce como de la lista.
- **Plan gratuito de Workers.** Da 10 ms de CPU por petición; por eso el Excel se genera y se lee en el navegador. Las rutas `GET /api/export.xlsx` y `POST /api/import` con el `.xlsx` crudo hacen ese trabajo en el servidor y pueden pasarse del límite con muchos meses.
- **Importaciones grandes en el plan gratuito de D1.** D1 admite 50 consultas por petición en ese plan. Una importación se guarda en un solo `batch` con una sentencia por cada 7 transacciones; no está confirmado si cada sentencia cuenta, así que un libro con varios cientos de transacciones podría fallar ahí.
- **Excel.** La columna de la vía de un envío sigue siendo, dentro del libro, una lista cerrada (Remitly, PayPal): Excel no deja escribir otra a mano ahí, aunque las que vienen de la app se exportan bien. Dentro del libro una meta se identifica por su nombre, así que dos metas con el mismo nombre mostrarían los mismos totales. LibreOffice muestra `#REF!` en «Income by month» para los meses que no tienen hoja; los libros no se han abierto en Microsoft Excel en esta versión.
- **claude.ai** solo puede usar el MCP si la organización tiene las cabeceras fijas (beta). Claude Code funciona siempre.
- Desde Claude no se editan ni se borran registros.
- **No se aceptan montos negativos** (un reembolso no se puede registrar como gasto negativo).
- El MCP no valida la cabecera `Origin` ni limita la frecuencia de llamadas; depende del Bearer y de Cloudflare.

### Diferencias con el prototipo

- Varios usuarios, tres idiomas, colores por usuario y metas editables; el prototipo era de una persona, en español y con tres metas fijas. Con la paleta original y en español, las dos pantallas se ven como en el prototipo, salvo el selector de usuario y el botón de ajustes de la barra superior, «Editar» en cada meta y la tarjeta «Agregar meta».
- La vía de un envío es texto libre con sugerencias; en el prototipo era una lista.
- Tres monedas, moneda principal y segunda por usuario, cuentas propias con saldos calculados, ingresos uno por uno, tasas por mes y presupuesto por cuenta; el prototipo tenía DOP y USD, dos cuentas con el saldo escrito a mano, un presupuesto y el ingreso del mes escrito. El panel de arriba es distinto en cada hoja: presupuesto en «Month», dinero total en «Savings».
- Se puede eliminar un mes, y los envíos y aportes se editan en su fila.
- Importar un Excel sustituye solo los meses que trae el archivo; el prototipo reemplazaba todo.
- En un mes cerrado también son de solo lectura el presupuesto y las tasas.
- Las tablas no enseñan una fila vacía para agregar: el «+ Add …» de la cabecera de cada tarjeta (o, en las tablas pequeñas con marco, debajo de él) la abre con el foco en su primer campo; Enter o su botón guardan y la dejan abierta para la siguiente, y Esc o el mismo botón (que pasa a decir «Cancel») la cierran y descartan lo escrito. En un mes cerrado no aparecen.
- Una celda de fecha se guarda al salir de ella o con Enter, no en cada cambio.
- Una celda numérica que se deja vacía muestra 0.
- Con un solo aporte, la tarjeta de la meta dice «1 aporte registrado» (el prototipo decía «1 aportes registrados»).
