# Handoff: Personal finances (web app + Excel export)

## Overview
Personal finance app for a user in the Dominican Republic who is paid in USD and spends in DOP. It lets the user:
- Record the month's transactions (date, description, place, category, method, amount, currency, notes).
- Keep track of the fixed monthly expenses (same items every month, variable amount) with a paid/unpaid status.
- Record USD → DOP transfers (Remitly / PayPal) with their rate; the month rate is the weighted average of those transfers.
- See on every screen: total money (US account in USD + DR account in DOP), the month's planned budget, used, available, and a budget donut with the used amount in the center.
- Close the month: the month becomes a read-only summary and the next one is created with the same fixed expenses, unpaid.
- Savings: each month's income, goals (Emergency fund, Personal savings, Trip to Turkey with 3,000 USD/month until Oct 2027) and contributions.
- Export everything to an .xlsx with the same design (one sheet per month + Savings + Config). If there is no data, the empty template is exported.
- Receive transactions from a chat with Claude (the user dictates "I spent X on Y" and Claude records it).

Deployment target: **Cloudflare Pages** (frontend) + **Pages Functions / Workers** (API) + **D1** (history).

## About the Design Files
The files in `referencia/` are **design references made in HTML**: a prototype that shows the expected look and behavior, not production code to copy as is. The task is to **recreate this design** in a new project. Recommended stack (there is no previous codebase):
- Frontend: React + Vite + TypeScript, deployed on Cloudflare Pages.
- API: Pages Functions (`/functions/api/*`) with a D1 binding.
- Styles: CSS modules or Tailwind with the tokens below. Everything renders on the client; no SSR is needed.

`referencia/excel-export.js`, however, **is reusable**: it generates the .xlsx with no dependencies (OOXML + uncompressed zip). It can be ported to TypeScript and used on the client or in a Worker.

## Fidelity
**High fidelity (hifi).** Colors, typography, spacing and interactions are final. Recreate it true to the prototype.

## Screens / Views

General layout: background `#EFEEE8`; centered content `max-width: 1320px`, padding `20px 24px 90px`, vertical gap 20px. Dark sticky top bar; tab bar fixed at the bottom (spreadsheet-tab style).

### Top bar (all screens)
- Background `#1D1F1C`, text `#F4F3EE`, padding `10px 24px`, flex-wrap, gap `12px 20px`.
- Left: "Personal finances" (700, 16px) + status subtitle (12px, `#A9ABA3`): "Current month" / "Month summary" / "Savings".
- Month select: ‹ button, `<select>` (min-width 190px, height 30px, background `#2B2E29`, border `#3A3D38`, radius 3px), › button. Options "October 2026", with the " · closed" suffix on closed months.
- "Import Excel" button (outline) and "Download Excel" button (background `#2F7D52`, hover `#23613F`).
- Chip "Month rate · 1 USD = 58.76 DOP" (monospaced).

### Summary panel (at the top of every screen)
Grid `repeat(auto-fit, minmax(280px, 1fr))`, separated by 1px lines `#E3E1D8`, 1px border, radius 4px, cells with background `#FFFEFA`, padding `18px 20px`.
1. **Total money**: label (11px, 600, uppercase, tracking .06em, `#6B6D66`); total in DOP (mono 28px 600) = `usAccount × rate + drAccount`; "≈ X USD" (mono 13px, muted). Small editable table: US account (USD), DR account (DOP). Row separated by a dashed border: "Month income − used" = `incomeUSD × rate − used` (red if negative).
2. **Donut** 168×168, r=64, thickness 20, hollow: segments in this order: Fixed paid `#2B3A33`, Transactions `#2F7D52`, Fixed pending `#C9D3C9`, background/free `#EBE9E1`. Scale = `max(budget, used + pending)`. Center: label "USED" + used amount (mono 19px 600; red `#B23A2A` if it goes over the budget) + "of 70,000 DOP". The legend goes on the right with the value of each segment.
3. **Month budget** (label/value list with `#EEECE5` separators): Planned budget (editable input), Used so far, Available (green `#23613F` / red if < 0), Available after pending fixed, Used in USD.

### "Month" screen
- **Closed-month banner** (closed months only): background `#1D1F1C`. It shows Income, Spent, Saved and Vs. budget, plus the "Reopen month" button.
- Flex-wrap row with a 20px gap:
  - **Fixed monthly expenses** (flex 1 1 600px): table with the columns Paid (checkbox, accent `#2F7D52`), Item, Day, Amount, Currency (DOP/USD), DOP (calc), USD (calc) and delete ×. The last row is the add row (background `#F9F8F3`). The header meta reads "6 of 11 paid · total 42,025.57 DOP".
  - Right column (flex 1 1 340px):
    - **By category**: horizontal bars (height 8px). "Fixed expenses" is in `#2B3A33` and the rest in `#2F7D52`, sorted from largest to smallest.
    - **Transfers USD → DOP**: table with Date, Via (Remitly/PayPal), USD, Rate and DOP (calc). It has an add row.
- **Transaction history**, full width: the add row goes at the top, followed by the rows sorted by date in descending order. Columns: Date, Description, Place, Category, Method, Amount, Cur., DOP, USD, Notes and ×. Minimum width of 980px with horizontal scroll.
- Dashed box for closing the month, with the text "Closing the month saves this summary and creates November 2026…" and the "Close October 2026" button (background `#1D1F1C`).
- **Close-month dialog**: the title is "Close October 2026" and the text explains that the next month will be created and asks whether to add it to the Excel file too. It has three buttons: Cancel, "Only on the page" and "Yes, add to Excel" (this one closes the month and downloads the .xlsx).

### "Savings" screen
- Goal cards in a grid `auto-fit minmax(260px,1fr)`. Each card shows the name, the type ("Variable contributions" or "3,000 USD / month"), the total saved in USD (mono 24px) and its equivalent in DOP.
  - Turkey also has a progress bar, "X% of 45,000 USD", the target (Oct 2027) and "N contributions left · X USD per month to get there".
- **Income by month**: table with Month, Income USD (editable), Rate, Income DOP, Saved USD and % saved.
- **Contributions**: table with Date, Goal, Amount, Currency, USD and DOP. It has an add row.

### Spreadsheet-style cells (shared)
- `th`: 11px, 600, uppercase, tracking .06em, `#6B6D66`, background `#F6F5F0`, bottom border `#E3E1D8`, right `#EBE9E2`.
- `td`: bottom border `#EEECE5` and right `#F1EFE9`. The input fills the whole cell, with no border and a transparent background, padding `7px 10px`.
- Cell focus: `box-shadow: inset 0 0 0 2px #2F7D52` and background `#fff`, like the Excel selection.
- Numbers are right-aligned in mono 12.5px. In closed months everything is read-only and the add rows and the × buttons are hidden.

## Interactions & Behavior
- **Month rate**: `Σ(usd × rate) / Σ(usd)` of the month's transfers. If there are no transfers, the rate of the most recent previous month is used; if there is none either, 58.76.
- **Conversion**: if the currency is USD, the amount in DOP is `amount × month rate`, and the equivalent USD is `DOP / rate`.
- **Month calculations**:
  - `fixedPaid = Σ DOP of the paid fixed expenses`
  - `transactions = Σ DOP of the transactions`
  - `used = fixedPaid + transactions`
  - `pending = Σ DOP of the unpaid fixed expenses`
  - `available = budget − used`
  - `afterFixed = available − pending`
- **Close month**: marks the month as `closed`. Creates the next month if it does not exist, copying the fixed expenses with `paid=false` and the same budget and income; transfers and transactions start empty.
- **Reopen month**: sets `closed=false` again.
- **Add**: validates that it has a description and amount > 0 (transaction), an item and amount > 0 (fixed expense), or USD and rate > 0 (transfer). After adding, it clears the fields and keeps the date.
- **Export Excel**: a workbook with one sheet per month ("October 2026"), plus the Savings and Config sheets. See `referencia/excel-export.js` and `referencia/Finanzas Personales v3.xlsx`. With no data, the output is the empty template for the current month (`referencia/Plantilla vacia.xlsx`).
- **Import Excel**: reads the same format and locates the tables by their headers ("Item", "Date"+"Via", "Date"+"Description"). See `importExcel` in the prototype.
- **Responsive**: the columns collapse into a single one with flex-wrap, and the tables scroll horizontally.

## Proposed architecture (Cloudflare)
- **Pages**: the Vite build. **Pages Functions** in `/functions/api/[[route]].ts` (or Hono).
- **Auth**: Cloudflare Access in front of the whole site, because it is a single-user app. So that Claude can write, use a separate Bearer token, stored as a secret (`API_TOKEN`), valid only on the `/api/ingest/*` and `/mcp` routes.
- **D1**: it is the source of truth for the history. Excel remains an export/import format.

### D1 schema (suggested)
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
- Categories: Food, Groceries, Transport, Entertainment, Health, Clothing, Home, Subscriptions, Education, Travel.
- Methods: Card, Transfer, Bank app.
- The transaction stores the original amount and currency. DOP/USD are calculated with the month rate and are not persisted.

### API (suggested)
- `GET /api/months` (list) · `GET /api/months/:key` (full month with fixed expenses, transactions and transfers) · `PATCH /api/months/:key`
- `POST /api/months/:key/close` → closes the month and creates the next one (in a D1 `batch` transaction) · `POST /api/months/:key/reopen`
- CRUD: `/api/fixed`, `/api/transactions`, `/api/transfers`, `/api/contributions`, `/api/goals`
- `GET /api/export.xlsx` → generates the workbook with `excel-export` (or generate it on the client).
- `POST /api/import` → receives the .xlsx and upserts.

### Recording from Claude
There are two options, from least to most effort:
1. **Ingest endpoint**: `POST /api/ingest/transaction` with Bearer, which receives `{date, description, place, category, method, amount, currency, notes}`. If the month does not exist, it creates it. Claude calls this endpoint through a tool or connector configured by the user.
2. **Remote MCP server** in a Worker (`/mcp`) with these tools:
   - `add_transaction`
   - `list_transactions(month)`
   - `month_summary(month)`
   - `add_transfer`
   - `mark_fixed_paid(name, month)`

   It is added as a custom connector in Claude. That way, in the chat, "I spent 850 on Uber today by card" becomes `add_transaction`.

## State Management (frontend)
- Server data with TanStack Query or similar: months, selected month (fixed expenses, transactions, transfers), goals and contributions.
- Local state: selected month (in the URL, `?mes=2026-10`), tab (Month/Savings), drafts of the add rows and the close-month dialog.
- Optimistic updates on cell edits, with a ~400ms debounce on numeric inputs.

## Design Tokens
- **Colors**:
  - Ink `#1D1F1C`, secondary text `#45473F`, muted `#6B6D66`, light gray `#A9ABA3`
  - Page background `#EFEEE8`, surface `#FFFEFA`, table header `#F6F5F0`, add row `#F9F8F3`
  - Borders `#E3E1D8`, `#EBE9E2`, `#EEECE5`, `#F1EFE9`, dashed `#CFCCC1`
  - Accent `#2F7D52` (hover `#23613F`), donut dark `#2B3A33`, pending `#C9D3C9`, free `#EBE9E1`
  - Error `#B23A2A`
  - Dark bar `#1D1F1C`, bar inputs `#2B2E29`, border `#3A3D38`
- **Typography**: UI in "Schibsted Grotesk" (400/500/600/700); numbers in "JetBrains Mono" (400/500/600) with `tabular-nums`.
  - Scale: 11 (uppercase labels), 12–12.5 (meta and numeric cells), 13 (body and tables), 15 (card titles, 600), 16 (brand), 19/24/28 (figures).
- **Spacing**: gaps of 6/8/10/12/14/20px. Card padding `14px 16px` and cell padding `7px 10px`.
- **Radii**: 3px on buttons and inputs, 4px on cards. No shadows, except the dialog (`0 12px 40px rgba(0,0,0,.18)`).

## Assets
None. There are no images or icons; the glyphs are text (‹ › × +).

## Files
- `referencia/Finanzas Personales.html` is the self-contained prototype. It opens in the browser and includes sample data, Excel import and export, and closing the month.
- `referencia/excel-export.js` is the .xlsx generator (it exposes `window.buildFinanzasXlsx(data)`). The shape of `data` is documented in `downloadExcel()` in the prototype.
- `referencia/Finanzas Personales v3.xlsx` is the sample Excel workbook with 3 months.
- `referencia/Plantilla vacia.xlsx` is the empty template.

## Sample data
The fixed expenses are: Electricity 1,337.15 DOP · Internet 2,699 · Health insurance 5,640 · Fridge payment 15,000 · Claude 106 USD (day 5) · Google One 121.56 (day 16) · iCloud+ 604 (day 17) · Cluely 308 · Smartfit 1,550 (day 17) · Netflix 1,137.30 · Unicaribe 7,400.

Monthly budget: 70,000 DOP. Reference Remitly rate: 58.76.
