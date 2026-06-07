# Agent Development Notes

## Scope

This repo is the unofficial Google Health MCP connector for local agent workflows.

## Commands

- Install: `npm ci`
- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Fast smoke: `npm run smoke`
- HTTP smoke: `npm run smoke:http`
- Full gate: `npm test`

## Rules

- Never commit OAuth client secrets, access tokens, refresh tokens, personal Google Health data, or local config.
- Keep read-only behavior and privacy-safe summaries as the default.
- Preserve agent-ready surfaces: manifest, connection status, privacy audit, CLI UX, Hermes agent manifest, and metadata checks.
- Keep error messages actionable without exposing credentials or raw private payloads.

## Conventions

- **Analytics services** live in `src/services/<name>.ts` and export an async
  `build<Name>(client, params)` returning a plain object, paired with a
  `format<Name>Markdown(result)`. Pure derivation helpers stay inline in the module
  (see `summary.ts`, `sleep.ts`).
- **Raw → clean parsing** is isolated in a `*-normalize.ts` service (`nutrition-normalize.ts`,
  `sleep-normalize.ts`). v4 payloads are loosely typed; extract with defensive
  multi-candidate key lookups (`pickNumber`/`pickString`/`findNestedNumber`), never assume
  a single field name.
- **Output envelope** for analytic results: `{ kind, generated_at, source: "google_health",
  window, beta: true, data_quality: {...}, <payload>, safety: { medical_advice: false, ... } }`.
  Output JSON keys are `snake_case`; internal TypeScript identifiers are `camelCase`.
- **Resilience:** wrap each upstream call so partial data never throws; surface a
  `data_quality.confidence` and what was missing.
- **Tools** register in `src/tools/google-health-tools.ts` via `server.registerTool(
  "google_health_<x>", { title, description, inputSchema: Schema.shape, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true,
  openWorldHint: true } }, handler)`. Handlers `try { … return makeResponse(result,
  params.response_format, format…Markdown(result)); } catch { return makeError(…) }`, take a
  `response_format` (json|markdown), and apply the privacy layer for raw passthrough.
- **Schemas** are zod, defined in `src/schemas/common.ts`.
- **Naming** is neutral and descriptive (`daily_summary`, `sleep_minutes`) — no editorializing
  adjectives in tool or field names.
- **Tests** are `node:assert` fixtures under `scripts/*.mjs`, import from `../dist/...`, use a
  `fakeClient`, and are wired into the `npm test` chain. Adding a tool also requires adding it
  to the `expectedTools` list in `scripts/smoke-tools.mjs`.
