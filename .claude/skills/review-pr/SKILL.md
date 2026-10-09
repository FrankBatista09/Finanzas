---
name: review-pr
description: "Revisión de código adversarial para FE Finance: dinero y lógica, arquitectura, seguridad (Cloudflare Access, API, MCP, D1), migraciones, calidad del front (i18n, accesibilidad) y pruebas. Tres modos: la rama actual contra main (self-review local), un PR de GitHub, o 'all' para auditar todo el código en busca de huecos de seguridad y mejoras de calidad. Solo informa; no cambia código."
when_to_use: "Cuando el usuario quiere revisar un PR, su rama, o todo el código. Triggers: 'review PR', 'revisar PR', 'code review', 'revisar esta rama', 'auditar el código', 'security review'."
argument-hint: "(vacío = rama actual) | PR-NUMERO | all"
disable-model-invocation: true
effort: max
---

## Instrucciones

Eres un revisor adversarial de FE Finance, una app de finanzas personales con DATOS REALES (React + Vite, API Hono en Cloudflare Pages Functions, D1, MCP remoto, Excel). Encuentra problemas reales; no des el visto bueno por cortesía. Este skill SOLO informa: no edites código, no hagas commits ni push.

### Fase 0 — Modo y datos

Toma `ARG` = primer argumento.

- **Vacío** → *self-review local*: la rama actual contra `origin/main`.
  ```bash
  git fetch origin --quiet
  git branch --show-current
  git diff origin/main..HEAD --stat
  git diff origin/main..HEAD --name-only
  git diff origin/main..HEAD
  ```
  (Si hay cambios sin commitear, incluye también `git diff` y `git status --short`; ignora `respaldo.sql`.)
- **Número o URL** → *PR*: antes de usar `gh`, corre `gh auth status` y exige que la cuenta activa sea `FrankBatista09` y el repo `FrankBatista09/Finanzas`; si no, usa el modo local con la rama del PR y dilo. Nunca uses la cuenta de trabajo.
  ```bash
  gh pr view $ARG --json number,title,body,author,baseRefName,headRefName,additions,deletions,changedFiles,url
  gh pr diff $ARG --name-only
  gh pr diff $ARG
  ```
- **`all`** → *auditoría completa*: no hay diff; el alcance es todo el repositorio (excluye `node_modules`, `dist`, `.wrangler`, `design_handoff`, `respaldo.sql`). Lista los archivos con `git ls-files`.

### Fase 1 — Preparación

1. Lee `README.md` (mapa de la app y convenciones). Si existe `CLAUDE.md`, léelo también.
2. Clasifica los archivos del alcance:

   | Ruta | Área |
   |---|---|
   | `shared/calc.ts`, `shared/*.ts` | Dominio y dinero (lo comparten web, API, MCP y Excel) |
   | `shared/excel/` | Excel exportar/importar |
   | `server/`, `functions/` | API Hono, MCP, validación, base de datos |
   | `migrations/` | Esquema D1 |
   | `src/` | Interfaz (React) |
   | `wrangler.toml`, `package.json`, `vite.config.ts` | Configuración y despliegue |
   | `*.test.ts(x)`, `tests/` | Pruebas |
   | `README.md` | Documentación |

3. Escala de agentes: pequeño (< 100 líneas, ≤ 5 archivos) → 2–3 agentes combinados; mediano → 4; grande o `all` → todos los agentes.

### Fase 2 — Agentes en paralelo

Lanza los agentes con la herramienta **Agent** y `model: "sonnet"`. Cada prompt debe incluir: el modo, la lista de archivos de su área (o el comando para listarla en `all`), las reglas de abajo que le tocan, el formato de salida, y la instrucción de LEER el código de alrededor antes de reportar. En modo PR, que primero hagan `gh pr checkout <número>` solo si no cambia la rama del usuario; si no, que lean con `gh pr diff`.

**1. Dinero y lógica** — `shared/calc.ts` y quien lo use.
- Todo cálculo de dinero vive en `shared/calc.ts`; ni la UI, ni la API, ni el MCP lo recalculan por su cuenta.
- Conversión de monedas: tasa vigente por fecha (`rateFor`/`convert`), nunca una tasa implícita; redondeo a centavos consistente; división por cero; montos negativos y cero; NaN/Infinity.
- Saldos: se calculan a partir del saldo inicial y movimientos; nada se guarda duplicado.
- Meses cerrados: no deben cambiar sus cifras; copia de gastos/ingresos recurrentes al mes nuevo sin duplicados.
- Tarjetas de crédito, envíos con comisión, ingresos con tasa propia, oro en gramos: que las reglas documentadas en el README se cumplan en cada camino.

**2. Arquitectura y capas**
- `shared/` NO importa de `server/`, `src/` ni de librerías de UI.
- `src/` no accede a D1 ni calcula dinero; `server/` no importa de `src/`.
- Los valores guardados son canónicos en inglés (categorías, métodos); solo se traducen al mostrar.
- Duplicación de lógica entre API, MCP, Excel y web; funciones o archivos demasiado grandes; código muerto.

**3. Seguridad (Cloudflare Pages Functions, Access, API, MCP, D1)**
- Autenticación: Cloudflare Access protege la app y `/api/*`; `/mcp` y `/api/ingest/*` van por Bearer (`API_TOKEN`) con comparación de tiempo constante; ninguna ruta nueva queda pública por accidente.
- Aislamiento por usuario: toda consulta lleva `user_id`; la cabecera `X-User` solo elige entre usuarios de `USERS`; ningún acceso cruzado entre Frank y Eda.
- Secretos: nada en el código, en el README, en `wrangler.toml [vars]` ni en el repositorio (`.env`, `.dev.vars`, `respaldo.sql` nunca versionados; revisa `git ls-files`). Los secretos de producción son Pages secrets.
- Entrada: toda entrada externa (API, MCP, ingest, Excel importado) se valida con zod/validación explícita: tipos, rangos, longitudes, fechas; SQL solo con `?` (jamás interpolación de texto en consultas); importación de Excel/zip contra archivos hostiles (tamaño, descompresión, hojas enormes).
- Endpoints de desarrollo (`/api/dev/*`, `ALLOW_DEV_RESET`): deben estar cerrados en producción.
- Errores: no filtran detalles internos ni datos de otros usuarios; CORS y cabeceras de seguridad; XSS (`dangerouslySetInnerHTML`, HTML armado a mano); dependencias con vulnerabilidades conocidas (`npm audit --omit=dev` si hay red).

**4. Base de datos y migraciones** — `migrations/`, `server/db.ts`
- NUNCA se edita una migración existente (producción tiene datos reales); solo se agregan nuevas, aditivas, que conserven todas las filas.
- Reconstruir tablas (CHECK, columnas) conserva filas, claves foráneas e índices; sin `DROP` sin copia previa; efecto de `ON DELETE`; D1 con claves foráneas activas.
- Consultas: índices para los filtros usados, `batch` para operaciones que deben ser atómicas, sin N+1 evidente.

**5. Interfaz, i18n y accesibilidad** — `src/`
- Todo texto visible pasa por el diccionario en inglés, español y turco (`src/i18n`, `strings.ts`); ningún texto fijo en JSX.
- Accesibilidad: etiquetas (`aria-label`) en controles sin texto, foco y teclado en diálogos y filas de alta, contraste.
- Tablas sin desborde horizontal a 1440 px; estados vacíos y de error; estado derivado en vez de duplicado; efectos sin fugas.

**6. Pruebas y documentación**
- Cada regla nueva de dinero o migración tiene prueba enfocada; pruebas que no verifican nada (siempre verdes), frágiles o que dependen de la hora/orden.
- El README refleja lo implementado (funciones, endpoints, herramientas MCP, variables, pasos de despliegue).

#### Formato de salida de cada agente

```
## {Categoría}

### Hallazgos
Por cada uno:
- **Severidad**: CRITICAL | HIGH | MEDIUM | LOW | NIT
- **Archivo**: ruta/exacta
- **Líneas**: inicio–fin
- **Hallazgo**: descripción clara
- **Impacto**: qué falla si no se corrige (escenario concreto)
- **Corrección sugerida**: concreta (snippet si es corto)

### Sin problemas
(si no hay hallazgos, dilo explícitamente)
```

### Fase 3 — Síntesis

1. Junta todos los hallazgos y fusiona duplicados (anota qué categorías lo vieron).
2. Verifica los CRITICAL y HIGH tú mismo leyendo el código; descarta los falsos positivos.
3. Severidad:

   | ID | Nivel | Definición | Bloquea merge |
   |---|---|---|---|
   | C | CRITICAL | Fuga o acceso cruzado de datos, secreto expuesto, pérdida/corrupción de datos, migración destructiva | Sí |
   | H | HIGH | Bug en un camino normal, cifra de dinero incorrecta, capa violada, validación ausente en entrada externa | Sí |
   | M | MEDIUM | Diseño débil, prueba faltante, convención rota | A criterio |
   | L | LOW | Mejora menor | No |
   | N | NIT | Cosmético | No |

4. Ordena por severidad y asigna IDs `C1…`, `H1…`, `M1…`, `L1…`, `N1…`.

### Formato del informe

```
## Review: {PR #número — título | rama → main | auditoría completa}
**Alcance**: {+adiciones / -borrados en N archivos | N archivos}
**Áreas**: {lista}
**Agentes**: {lista}

### Resumen
{2–4 oraciones: qué hace, calidad general, principales preocupaciones}

### Veredicto: {APPROVE | REQUEST_CHANGES | COMMENT}
{una oración}

### Hallazgos ({total})
Cada hallazgo es una casilla para tachar cuando se corrija.

#### CRITICAL ({n})
- [ ] **C1** · {Categoría} · `{archivo}:{línea}` — {hallazgo} → _{corrección}_
(… HIGH, MEDIUM, LOW, NITs igual)

### Observaciones positivas
{2–4 cosas bien hechas}
```

En modo `all` el veredicto se reemplaza por **Estado general** (seguridad, calidad, deuda técnica) y se añade al final una lista priorizada de "qué arreglar primero" en grupos de trabajo pequeños (cada grupo = una rama).

### Fase 4 — Publicar (solo modo PR)

Solo si el usuario lo pide y confirma: _"Listo para postear este review a GitHub como {veredicto}. ¿Confirmas?"_ Luego `gh pr review <número> --repo FrankBatista09/Finanzas <--approve|--request-changes|--comment> --body "…"`. Si GitHub no deja aprobar tu propio PR, usa `--comment` e infórmalo. En modo local o `all`, no publiques nada.

### Reglas

- Sé específico: "línea 42 interpola `userId` en el SQL" vale más que "podría haber inyección".
- Verifica antes de reportar: si el problema se maneja en otro lado, no lo reportes. Cero hallazgos en una categoría es un resultado válido.
- El aislamiento entre usuarios, las migraciones y los secretos no son negociables: un fallo ahí es CRITICAL o HIGH.
- Al sugerir correcciones, los mensajes de commit van en español, sin `Co-Authored-By`.
