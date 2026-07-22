# KnowBook — Agent Quick Reference

# 首要原则, 用中文

## Project Overview
- **Type**: Electron desktop app (local-first knowledge management)
- **Stack**: TypeScript, React, SQLite (`better-sqlite3`), Vite, Electron
- **Entry**: `src/main/index.ts` (main process), `src/renderer/src/main.tsx` (renderer)
- **Shared types & contracts**: `src/shared/contracts.ts`
- **Build tool**: `electron-vite` (see `electron.vite.config.ts`)

## Developer Commands (package.json)
- `npm run dev` — Start dev server + Electron in development
- `npm run build` — Type-check then build for production
- `npm run preview` — Preview production build
- `npm run test` — Run all tests (main + renderer) via `electron --test`
- `npm run typecheck` — Run `tsc --noEmit` on both configs
- `npm run postinstall` — Rebuild `better-sqlite3` native module

## Test / Verification
- Unit/integration tests: `tests/` (Node-style `node:test` in main process)
- E2E tests: `e2e-tests/` (Playwright; config in `playwright.config.ts`)
- Run tests: `npm run test`
- Lint/typecheck: `npm run typecheck` (no separate lint script; use tsc)
- After changes, at minimum run: `npm run typecheck && npm run test`

## Architecture (three process boundaries)
- **Main** (`src/main/`): Electron main process, SQLite store (`database/store.ts`), backup service, plugin host, IPC handlers. Owns the database file.
- **Preload** (`src/preload/index.ts`): Exposes a safe `window.knowbook` API to renderer (typed in `contracts.ts`).
- **Renderer** (`src/renderer/src/`): React UI, calls `window.knowbook.*` IPC methods for all persistence/AI/plugin operations.
- **Shared** (`src/shared/`): Contracts, types, and small utilities used by both main and renderer.

## Core Module Responsibilities
- `src/main/database/store.ts` — SQLite schema, document/tree operations, database entities, related-note search candidates, workspace events.
- `src/main/backup/exporter.ts` — Markdown export/backup of all documents.
- `src/main/plugin-host.ts` (and related plugin SDK files) — Workspace plugin system, plugin lifecycle, plugin actions/dashboard cards.
- `src/main/event-bus.ts` — Internal workspace event bus; plugins and features subscribe to document/AI/plugin events.
- `src/renderer/src/App.tsx` + `components/` — React UI; state is primarily fetched via `window.knowbook.*` IPC calls.
- `src/shared/contracts.ts` — All IPC method signatures and data types. If you change an API shape, update here and both sides.

## Important Conventions & Quirks
- **Database file location**: `app.getPath('userData')/storage/knowbook.db` (created by main). Tests create isolated temp DBs.
- **AI & related notes**: Optional OpenAI-compatible endpoints. Related-note retrieval uses local keyword matching over document title, summary, and block content. Auto-summary runs via an event-bus subscriber on document update when AI is enabled.
- **Plugins**: Two plugin roots — workspace `plugins/` (dev) and user-data `plugins/`. Workspace plugins can't be replaced by user install (error); user-data plugins can be replaced. Plugin manifest fields: id, name, version, entry (optional), enabledByDefault.
- **Document tree**: Hierarchical by `parentId`. Path is materialized (e.g., `Home/Product/Specs`). Renaming/moving rewrites descendant paths automatically. Path normalization uses title; siblings get `Untitled`, `Untitled 1`, ... on conflict.
- **Block references & linking**: Stored as `blockId` references. When a document title changes, link labels are updated; outgoing/incoming links are computed via markdown link parsing.
- **Database columns**: Types include `text`/`select`/`multi-select`/`checkbox`/`date`. Select/multi-select validation and option pruning occur when options change (invalid values become undefined).
- **i18n**: Some strings are localized (see `src/renderer/src/i18n.ts`). Expect Chinese UI strings in production.

## Environment & Paths
- Dev renderer URL: `process.env.ELECTRON_RENDERER_URL` (Vite dev server), else loads `renderer/index.html`.
- Preload script in prod build: `../preload/index.cjs` (CommonJS is required by Electron's sandboxed preload loader).
- Tests run with `ELECTRON_RUN_AS_NODE=1` and `tsx` register.

## Working with AI Features (non-breaking guidance)
- All AI operations go through `window.knowbook.*` IPC methods and require `aiConfig.enabled` + API key.
- To add new AI automation: (1) add IPC handler in main, (2) define event subscription (event-bus) if it should run automatically, (3) update contracts types, (4) optionally add UI toggle in renderer settings.
- Related-note retrieval is computed on demand from SQLite-backed document candidates. AI config changes do not trigger any background embedding sync or vector backfill.

## Plugin Development Notes
- Plugin host loads manifests and entry modules. If entry is omitted, host may auto-resolve common entry names.
- Plugin can contribute: dashboard cards, document actions, settings, and listen to workspace events via the exposed plugin API (see plugin-sdk.ts/plugin-host.ts).
- To add plugin APIs: extend plugin-host/plugin-sdk and contracts, keep renderer calls via `window.knowbook`.

## Common Gotchas
- `better-sqlite3` is native — after `npm install`, `postinstall` rebuilds it. CI/test environments must provide build tools or skip native modules.
- Always run `npm run typecheck` before committing — strict TypeScript with path mappings (`@renderer`, `@shared`).
- IPC payloads must match `contracts.ts` exactly — mismatches cause runtime type errors in renderer.
- E2E tests (Playwright) expect dev server on `http://localhost:5173`; CI config sets retries and trace-on-first-retry.

## Adding Tests
- Main-process tests: use `node:test` + temp DB factory (`withStore` pattern from existing tests).
- Renderer tests: existing tests use React testing patterns (`@testing-library/react` style); see `tests/renderer-*.test.tsx`.
- E2E: add `.spec.ts` in `e2e-tests/` and update `playwright.config.ts` if needed.

## References (kept intentionally minimal)
- Type definitions: `src/shared/contracts.ts`
- Main entry: `src/main/index.ts`
- Store (SQLite): `src/main/database/store.ts`
- Plugin system: `src/main/plugin-host.ts`, `src/main/plugin-sdk.ts`
- UI root: `src/renderer/src/App.tsx`
- Event bus: `src/main/event-bus.ts`
