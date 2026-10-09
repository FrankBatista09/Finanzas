---
name: review-pr
description: "Adversarial code review for FE Finance: money and logic, architecture, security (Cloudflare Access, API, MCP, D1), migrations, front-end quality (i18n, accessibility) and tests. Three modes: the current branch against main (local self-review), a GitHub PR, or 'all' to audit the whole codebase for security holes and quality improvements. Reports only; never changes code. The report is written in English."
when_to_use: "When the user wants to review a PR, their branch, or the whole code. Triggers: 'review PR', 'revisar PR', 'code review', 'revisar esta rama', 'auditar el código', 'security review'."
argument-hint: "(empty = current branch) | PR-NUMBER | all"
disable-model-invocation: true
effort: max
---

## Instructions

You are an adversarial reviewer of FE Finance, a personal finance app with REAL DATA (React + Vite, Hono API on Cloudflare Pages Functions, D1, remote MCP, Excel). Find real problems; do not approve out of politeness. This skill ONLY reports: do not edit code, do not commit or push. Write the report in English.

### Phase 0 — Mode and data

Take `ARG` = first argument.

- **Empty** → *local self-review*: the current branch against `origin/main`.
  ```bash
  git fetch origin --quiet
  git branch --show-current
  git diff origin/main..HEAD --stat
  git diff origin/main..HEAD --name-only
  git diff origin/main..HEAD
  ```
  (If there are uncommitted changes, also include `git diff` and `git status --short`; ignore `respaldo.sql`.)
- **Number or URL** → *PR*: before using `gh`, run `gh auth status` and require the active account to be `FrankBatista09` and the repo `FrankBatista09/Finanzas`; otherwise fall back to local mode with the PR's branch and say so. Never use a work account.
  ```bash
  gh pr view $ARG --json number,title,body,author,baseRefName,headRefName,additions,deletions,changedFiles,url
  gh pr diff $ARG --name-only
  gh pr diff $ARG
  ```
- **`all`** → *full audit*: no diff; the scope is the whole repository (exclude `node_modules`, `dist`, `.wrangler`, `design_handoff`, `respaldo.sql`). List files with `git ls-files`.

### Phase 1 — Preparation

1. Read `README.md` (app map and conventions). If `CLAUDE.md` exists, read it too.
2. Classify the files in scope:

   | Path | Area |
   |---|---|
   | `shared/calc.ts`, `shared/*.ts` | Domain and money (shared by web, API, MCP and Excel) |
   | `shared/excel/` | Excel export/import |
   | `server/`, `functions/` | Hono API, MCP, validation, database |
   | `migrations/` | D1 schema |
   | `src/` | UI (React) |
   | `wrangler.toml`, `package.json`, `vite.config.ts` | Configuration and deploy |
   | `*.test.ts(x)`, `tests/` | Tests |
   | `README.md` | Documentation |

3. Scale the agents: small (< 100 lines, ≤ 5 files) → 2–3 combined agents; medium → 4; large or `all` → all agents.

### Phase 2 — Parallel agents

Launch the agents with the **Agent** tool and `model: "sonnet"`. Each prompt must include: the mode, the list of files in its area (or the command to list them in `all`), the rules below that apply to it, the output format, and the instruction to READ the surrounding code before reporting. In PR mode they read with `gh pr diff` and must not change the user's checked-out branch.

**1. Money and logic** — `shared/calc.ts` and its consumers.
- All money math lives in `shared/calc.ts`; the UI, API and MCP never recompute it on their own.
- Currency conversion: the rate in effect on the date (`rateFor`/`convert`), never an implicit rate; consistent rounding to cents; division by zero; negative and zero amounts; NaN/Infinity.
- Balances are computed from opening balance plus movements; nothing is stored twice.
- Closed months must not change their figures; recurring expenses/incomes copied into a new month without duplicates.
- Credit cards, transfers with fees, incomes with their own rate, gold in grams: the rules documented in the README hold on every path.

**2. Architecture and layers**
- `shared/` does NOT import from `server/`, `src/` or UI libraries.
- `src/` does not access D1 or compute money; `server/` does not import from `src/`.
- Stored values are canonical English (categories, methods); they are translated only when displayed.
- Logic duplicated across API, MCP, Excel and web; oversized functions or files; dead code.

**3. Security (Cloudflare Pages Functions, Access, API, MCP, D1)**
- Authentication: Cloudflare Access protects the app and `/api/*`; `/mcp` and `/api/ingest/*` use a Bearer token (`API_TOKEN`) with constant-time comparison; no new route becomes public by accident.
- Per-user isolation: every query carries `user_id`; the `X-User` header only selects among the `USERS` users; no cross access between users.
- Secrets: none in code, README, `wrangler.toml [vars]` or the repository (`.env`, `.dev.vars`, `respaldo.sql` never versioned; check `git ls-files`). Production secrets are Pages secrets.
- Input: every external input (API, MCP, ingest, imported Excel) is validated: types, ranges, lengths, dates; SQL only with `?` placeholders (never string interpolation); Excel/zip import against hostile files (size, decompression, huge sheets).
- Development endpoints (`/api/dev/*`, `ALLOW_DEV_RESET`) must be closed in production.
- Errors do not leak internals or other users' data; CORS and security headers; XSS (`dangerouslySetInnerHTML`, hand-built HTML); dependencies with known vulnerabilities (`npm audit --omit=dev` if there is network).

**4. Database and migrations** — `migrations/`, `server/db.ts`
- An existing migration is NEVER edited (production has real data); only new, additive migrations that keep every row.
- Rebuilding tables (CHECK, columns) preserves rows, foreign keys and indexes; no `DROP` without a prior copy; `ON DELETE` effects; D1 runs with foreign keys on.
- Queries: indexes for the filters used, `batch` for operations that must be atomic, no obvious N+1.

**5. UI, i18n and accessibility** — `src/`
- All visible text goes through the English/Spanish/Turkish dictionaries (`src/i18n`, `strings.ts`); no hard-coded text in JSX.
- Accessibility: `aria-label` on controls without text, focus and keyboard in dialogs and add rows, contrast.
- Tables without horizontal overflow at 1440 px; empty and error states; derived state instead of duplicated state; effects without leaks.

**6. Tests, docs and conventions**
- Every new money rule or migration has a focused test; tests that verify nothing (always green), brittle ones, or ones that depend on time/order.
- The README reflects what is implemented (features, endpoints, MCP tools, variables, deploy steps).
- Conventions: new code, comments, commit/PR text and docs are in English; branch name `feat/…`, `fix/…`, etc.; Conventional Commits titles.

#### Output format for each agent

```
## {Category}

### Findings
For each one:
- **Severity**: CRITICAL | HIGH | MEDIUM | LOW | NIT
- **File**: exact/path
- **Lines**: start–end
- **Finding**: clear description
- **Impact**: what fails if it is not fixed (concrete scenario)
- **Suggested fix**: concrete (snippet if short)

### No problems
(if there are no findings, say so explicitly)
```

### Phase 3 — Synthesis

1. Merge all findings and de-duplicate (note which categories saw each).
2. Verify every CRITICAL and HIGH yourself by reading the code; discard false positives.
3. Severity:

   | ID | Level | Definition | Blocks merge |
   |---|---|---|---|
   | C | CRITICAL | Data leak or cross-user access, exposed secret, data loss/corruption, destructive migration | Yes |
   | H | HIGH | Bug on a normal path, wrong money figure, layer violation, missing validation on external input | Yes |
   | M | MEDIUM | Weak design, missing test, broken convention | At reviewer's discretion |
   | L | LOW | Minor improvement | No |
   | N | NIT | Cosmetic | No |

4. Sort by severity and assign IDs `C1…`, `H1…`, `M1…`, `L1…`, `N1…`.

### Report format

```
## Review: {PR #number — title | branch → main | full audit}
**Scope**: {+additions / -deletions in N files | N files}
**Areas**: {list}
**Agents**: {list}

### Summary
{2–4 sentences: what it does, overall quality, main concerns}

### Verdict: {APPROVE | REQUEST_CHANGES | COMMENT}
{one sentence}

### Findings ({total})
Each finding is a checkbox to tick once fixed.

#### CRITICAL ({n})
- [ ] **C1** · {Category} · `{file}:{line}` — {finding} → _{fix}_
(… HIGH, MEDIUM, LOW, NITs the same way)

### What is done well
{2–4 things done right}
```

In `all` mode, replace the verdict with **Overall status** (security, quality, technical debt) and end with a prioritized "fix first" list in small work groups (each group = one branch, named `fix/…` or `chore/…`).

### Phase 4 — Post (PR mode only)

Only if the user asks and confirms: _"Ready to post this review to GitHub as {verdict}. Confirm?"_ Then `gh pr review <number> --repo FrankBatista09/Finanzas <--approve|--request-changes|--comment> --body "…"`. If GitHub does not let you approve your own PR, use `--comment` and say so. In local or `all` mode, post nothing.

### Rules

- Be specific: "line 42 interpolates `userId` into the SQL" beats "there might be injection".
- Verify before reporting: if the problem is handled elsewhere, do not report it. Zero findings in a category is a valid result.
- Per-user isolation, migrations and secrets are non-negotiable: a failure there is CRITICAL or HIGH.
- When suggesting fixes, commit messages are English Conventional Commits without `Co-Authored-By`.
