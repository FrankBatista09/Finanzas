---
name: open-pr
description: "Creates or updates the PR for the current branch of FE Finance (FrankBatista09/Finanzas) with a standardized English description: what it does, changes, database migrations, security notes, test plan and deploy steps. The PR title follows Conventional Commits. Creates a ready-for-review PR (NOT a draft). Never commits or pushes: if something is uncommitted or unpushed it stops and says which commands to run."
when_to_use: "When the user wants to open or update a PR. Triggers: 'open PR', 'abrir PR', 'crear PR', 'actualizar PR', 'open pull request'."
argument-hint: "(optional) extra note for the description"
disable-model-invocation: true
---

## Instructions

You are opening (or updating) the PR for the current branch of FE Finance. This is a PERSONAL project: everything happens with the personal `FrankBatista09` account, never with a work account. Everything you write (title, description) is in English.

### Step 0 — Account guard (mandatory, before anything else)

```bash
gh auth status 2>&1
git remote get-url origin
git branch --show-current
```

Continue only if ALL of these hold:
- the `origin` remote points to `FrankBatista09/Finanzas`;
- the ACTIVE `gh` account for github.com is `FrankBatista09`;
- the current branch is NOT `main`.

If the active account is another one (for example the work account), STOP and say: _"The active gh account is not FrankBatista09. Run `gh auth switch -u FrankBatista09` (or `gh auth login` if it is not added yet) and run /open-pr again."_ Never create the PR with another account, never ask for or type tokens, and never switch accounts yourself.

### Step 1 — Branch context

```bash
git status --short
git fetch origin --quiet
git log origin/main..HEAD --oneline
git diff origin/main..HEAD --stat
git diff origin/main..HEAD --name-only
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>&1
git status -sb | head -1
gh pr view --json number,url,title,state 2>&1
```

- Uncommitted changes (ignore the loose `respaldo.sql` file, which is NEVER committed): STOP and tell the user to commit first, with the commands (`git add <files>` and `git commit -m "<conventional message>"`, no Co-Authored-By).
- No upstream, or the branch is ahead of the remote: STOP and give `git push -u origin <branch>`.
- No commits on top of `origin/main`: there is nothing to open; say so.
- Branch name not following `feat/…`, `fix/…`, `chore/…`, `refactor/…`, `docs/…`, `test/…`, `ci/…`: warn the user (it is not blocking) and suggest `git branch -m <new-name>` before pushing.

### Step 2 — Understand the change

1. Read the full diff (`git diff origin/main..HEAD`) and README.md (app map, conventions).
2. List new migrations: `git diff origin/main..HEAD --name-only -- migrations/`. If any, deployment needs `npm run db:migrate:remote`.
3. Detect changes to secrets, variables (`wrangler.toml`), public routes (`/mcp`, `/api/ingest`) or authentication: these are security points to call out.

### Step 3 — Title (Conventional Commits)

Format: `type(scope): short imperative description`, in English, lowercase after the colon, no trailing period.

| Type | Use | Version effect |
|---|---|---|
| `feat` | something new for the user | minor |
| `fix` | fixes a bug | patch |
| `feat!` / `fix!` (or a `BREAKING CHANGE:` footer in the description) | breaks something that worked before | major |
| `refactor`, `perf`, `chore`, `docs`, `test`, `ci` | no user-visible change | no release |

The title is what ends up on `main` (squash merge), so it must be accurate. Example: `feat(cards): add multiple credit cards with limit and cutoff day`. Use `!` and a `BREAKING CHANGE:` section in the description whenever the change breaks existing behavior (API, MCP tools, stored data contracts).

### Step 4 — Description

Use this template with real content (no generic filler):

```markdown
## What does this PR do?

<2–3 sentences: what can be done now and why>

---

## Main changes

- `path/file` — <what changed and why>

---

## Database

<New migrations (name and what they do) and whether they preserve existing data. If none: "No migrations.">

---

## Security and risks

<Authentication, secrets, input validation, public routes, real data in production. If none apply: "No security impact.">

---

## Breaking changes

<Only if the title has `!`: what breaks and how to migrate. Otherwise omit this section.>

---

## Test plan

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] <specific manual scenario tested in the browser>

---

## Deploy

After merging, in the project folder:

1. `git checkout main && git pull`
2. `npm run db:migrate:remote`   <!-- only if there are migrations; otherwise omit this step -->
3. `npm run deploy`
```

### Step 5 — Confirm and create

If `gh pr view` found no PR → CREATE mode. If it found an open one → UPDATE mode.

Show the full title and description and ask: _"Shall we create the PR with this?"_ (or _"PR #N already exists. Update title and description?"_). Do not continue until the user confirms.

CREATE (NOT a draft; the PR is ready for review):

```bash
gh pr create \
  --base main \
  --head "<branch>" \
  --title "<title>" \
  --body "$(cat <<'EOF'
<description>
EOF
)"
```

UPDATE:

```bash
gh pr edit <number> --title "<title>" --body "$(cat <<'EOF'
<description>
EOF
)"
```

### Step 6 — Wrap up

Show the PR URL and the next steps: _"To review it: `/review-pr <number>`. After merging, run the Deploy steps from the description."_

---

### Rules

- Never commit, push, merge or deploy from this skill. You only create or update the PR.
- Never add `Co-Authored-By`, nor mention Claude or any AI, in the title or description.
- Do not invent: if there were no migrations or security changes, say so with the short phrase from the template.
- Never include secrets, tokens, or the contents of `.env`, `.dev.vars` or `respaldo.sql`.
