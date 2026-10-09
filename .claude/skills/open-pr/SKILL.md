---
name: open-pr
description: "Crea o actualiza el PR de la rama actual de FE Finance (FrankBatista09/Finanzas) con una descripción estandarizada: qué hace, cambios, migraciones y pasos de despliegue, plan de prueba. Crea el PR listo para revisar (NO draft). No hace commits ni push: si hay algo sin commitear o sin subir, se detiene y dice qué comandos correr."
when_to_use: "Cuando el usuario quiere abrir o actualizar un PR. Triggers: 'open PR', 'abrir PR', 'crear PR', 'actualizar PR', 'open pull request'."
argument-hint: "(opcional) título o nota extra para la descripción"
disable-model-invocation: true
---

## Instrucciones

Vas a abrir (o actualizar) el PR de la rama actual de FE Finance. Este es un proyecto PERSONAL: todo ocurre con la cuenta personal `FrankBatista09`, nunca con la cuenta de trabajo.

### Paso 0 — Guardia de cuenta (obligatorio, antes de cualquier otra cosa)

```bash
gh auth status 2>&1
git remote get-url origin
git branch --show-current
```

Continúa solo si TODO esto es cierto:
- el remoto `origin` apunta a `FrankBatista09/Finanzas`;
- la cuenta ACTIVA de `gh` para github.com es `FrankBatista09`;
- la rama actual NO es `main`.

Si la cuenta activa es otra (por ejemplo la de trabajo), DETENTE y di: _"La cuenta activa de gh no es FrankBatista09. Corre `gh auth switch -u FrankBatista09` (o `gh auth login` si no está agregada) y vuelve a lanzar /open-pr."_ Nunca crees el PR con otra cuenta, nunca pidas ni escribas tokens, y no cambies la cuenta tú mismo.

### Paso 1 — Contexto de la rama

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

- Si hay cambios sin commitear (ignora el archivo suelto `respaldo.sql`, que NUNCA se sube): DETENTE y di que primero deben hacer commit; da los comandos (`git add <archivos>` y `git commit -m "…"`, sin Co-Authored-By).
- Si no hay upstream o la rama está adelantada del remoto: DETENTE y da `git push -u origin <rama>`.
- Si no hay commits sobre `origin/main`: no hay nada que abrir; dilo.

### Paso 2 — Entender el cambio

1. Lee el diff completo (`git diff origin/main..HEAD`) y el README.md (mapa de la app, convenciones).
2. Lista las migraciones nuevas: `git diff origin/main..HEAD --name-only -- migrations/`. Si hay, el despliegue necesita `npm run db:migrate:remote`.
3. Detecta si cambian secretos, variables (`wrangler.toml`), rutas públicas (`/mcp`, `/api/ingest`) o autenticación: son puntos de seguridad a destacar.

### Paso 3 — Título

Formato: `tipo(alcance): descripción corta en imperativo`, en español.
Tipos: `feat` (algo nuevo para el usuario), `fix` (corrige un error), `refactor`, `chore` (mantenimiento, dependencias), `docs`, `test`, `ci`.
Ejemplo: `feat(tarjetas): varias tarjetas de crédito con límite y corte`.
Si el cambio rompe algo existente, añade `!` tras el alcance (`feat(api)!: …`) y explícalo en la descripción.

### Paso 4 — Descripción

Usa esta plantilla con contenido real (nada genérico de relleno):

```markdown
## ¿Qué hace este PR?

<2–3 oraciones: qué se puede hacer ahora y por qué>

---

## Cambios principales

- `ruta/archivo` — <qué cambió y por qué>

---

## Base de datos

<Migraciones nuevas (nombre y qué hacen) y si conservan los datos existentes. Si no hay: "Sin migraciones.">

---

## Seguridad y riesgos

<Autenticación, secretos, validación de entrada, rutas públicas, datos reales en producción. Si nada aplica: "Sin impacto de seguridad.">

---

## Plan de prueba

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] <escenario manual concreto probado en el navegador>

---

## Despliegue

Tras el merge, en la carpeta del proyecto:

1. `git checkout main && git pull`
2. `npm run db:migrate:remote`   <!-- solo si hay migraciones; si no, omitir este paso -->
3. `npm run deploy`

**Versión**: <si el cambio requiere subir versión, indicar patch/minor/major; si el proyecto aún no usa releases, omitir>
```

### Paso 5 — Confirmar y crear

Si `gh pr view` no encontró PR → modo CREAR. Si encontró uno abierto → modo ACTUALIZAR.

Muestra el título y la descripción completos y pregunta: _"¿Creamos el PR con esto?"_ (o _"Ya existe el PR #N. ¿Actualizo título y descripción?"_). No sigas hasta que el usuario confirme.

CREAR (NO es draft; el PR queda listo para revisar):

```bash
gh pr create \
  --base main \
  --head "<rama>" \
  --title "<título>" \
  --body "$(cat <<'EOF'
<descripción>
EOF
)"
```

ACTUALIZAR:

```bash
gh pr edit <número> --title "<título>" --body "$(cat <<'EOF'
<descripción>
EOF
)"
```

### Paso 6 — Cierre

Muestra la URL del PR y los siguientes pasos: _"Para revisarlo: `/review-pr <número>`. Cuando lo hagas merge, corre los pasos de la sección Despliegue."_

---

### Reglas

- Nunca hagas commits, push, merge ni despliegues desde este skill. Solo creas o actualizas el PR.
- Nunca agregues `Co-Authored-By`, ni menciones a Claude o a una IA, en el título ni en la descripción.
- No inventes: si no hubo migraciones o cambios de seguridad, dilo con la frase corta de la plantilla.
- Nunca incluyas secretos, tokens, ni contenido de `.env`, `.dev.vars` o `respaldo.sql`.
