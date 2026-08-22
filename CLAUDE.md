# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

NeuroSync — a pitch/demo web project for an adaptive-routine app aimed at autistic and ADHD users (Brazilian Portuguese, `pt-BR`). The frontend is two self-contained HTML files (inline `<style>` and `<script>`, no external JS/CSS dependencies besides Google Fonts), served by a tiny built-in-modules-only Node backend:

- `index.html` — the marketing/pitch landing page (hero, stats, problem/solution, pricing, contact). Static content plus a small scroll-progress/reveal-on-scroll script.
- `app.html` — the actual product: sign in/sign up + a single-page app (onboarding + 6 screens) simulating the NeuroSync routine tracker. Persists to the backend instead of localStorage.
- `server.js` — a plain Node `http` server (no Express, no npm dependencies). Serves `index.html`/`app.html` as static files and exposes the `/api/*` auth + storage routes described below.
- `data/users/` — created at runtime; one JSON file per account (`sha256(email).json`), holding the password hash/salt and that user's app state. Git-ignored — never commit real user data.

There is no build system, no bundler, and no test suite; `package.json` exists only for `npm start` (no dependencies to install). There is no git repository initialized in this directory.

## Running it

`node server.js` (or `npm start`) starts the server on `http://localhost:3000` (override with `PORT`). Open `app.html` through that URL — opening the file directly (`file://`) breaks sign-in/storage since there's no backend to call.

## Working with this codebase

- Frontend is hand-written vanilla HTML/CSS/JS — no framework, no JSX, no TypeScript, no bundler. Edit the files directly.
- `server.js` intentionally uses only Node's built-in modules (`http`, `fs`, `crypto`, `path`, `url`) — do not add Express or any npm dependency without the user explicitly asking; keep `package.json` dependency-free.
- There is no linter or test command configured. Verify changes by running `node server.js` and exercising the UI (including sign up/sign in/sign out) in a browser.
- Keep new frontend code dependency-free and inline, consistent with the rest of the file — do not introduce a build step, bundler, or external JS library unless the user explicitly asks for one.

## `server.js` architecture

Plain `http.createServer` with no router library:

1. **Accounts** — `POST /api/signup` (email + password ≥ 6 chars + optional name) and `POST /api/login` create/verify an account and start a session; passwords are hashed with `crypto.scryptSync` (per-user random salt), never stored in plaintext.
2. **Sessions** — an in-memory `Map` from a random token (set as an `HttpOnly` `ns_session` cookie) to `{ userId, expires }`, 30-day TTL. Sessions live only in memory — restarting the server logs everyone out (but their file-backed data is untouched).
3. **Per-user storage** — `GET /api/me` (identity + saved `state`), `POST /api/state` (overwrite saved `state`), `DELETE /api/account` (erase the user's file and session) — all require a valid session cookie. Each account is one JSON file in `data/users/`, keyed by `sha256(email)` so filenames never leak the raw address.
4. **Padrinhos (sponsorship)** — every account gets a public 6-char `code` (generated at signup, unique via `findByCode` scanning `data/users/`) that a friend can be invited by. `/api/sponsor/invite|cancel|revoke|respond|leave` let a Padrinho-tier user (`state.user.plan === "premium" && state.user.tier === PADRINHO_PRICE`) grant one friend free Premium: `sponsoring` (on the padrinho's record) and `pendingInvite`/`sponsoredBy` (on the friend's) are top-level account fields, not part of the client-controlled `state` blob, so a stale `POST /api/state` can't clobber them — `POST /api/state` re-forces `state.user.plan = "premium"` whenever `sponsoredBy` is set. `clearSponsoringSide`/`clearSponsoredSide` keep both sides of the relationship in sync on cancel/revoke/leave/account deletion.
5. **Static files** — any other `GET`/`HEAD` is served from the project root (path-traversal-guarded, and `/data` is never served).

## `app.html` architecture

`app.html` is a hand-rolled SPA. Key parts, top to bottom in the `<script>` block:

1. **Persistence (`Store`)** — `Store.save(state)` POSTs the whole state blob to `/api/state` with `credentials: "include"` so the session cookie rides along. All state mutations should go through `persist()` (wraps `Store.save(state)`) after changing `state`.
2. **Auth (`renderAuth`/`handleAuthSubmit`/`afterAuth`)** — a login/signup screen (`#authScreen`) shown when `boot()`'s `GET /api/me` comes back unauthenticated. On success, `afterAuth(account)` loads that account's saved `state` (or a blank one) and either resumes onboarding or jumps into the app. `showAuth()` tears down local `state` and returns to this screen (used by logout and account deletion in Perfil). `applyAccountMeta(account)` copies the server-authoritative `code`/`sponsoring`/`pendingInvite`/`sponsoredBy` fields onto `state.user` for display; `refreshAccountMeta()` re-fetches `/api/me` and reapplies them after any sponsor action. `finishOnboarding()` preserves these fields when it rebuilds `state.user`.
3. **State shape (`blankState()`)** — one global `state` object: `user` (profile/plan/rhythm), `tasks`, `checkins`, `focus`, `history`, `wearable`. `migrate(st)` upgrades older saved shapes on load (e.g. legacy block-based tasks → `time`/`end`/`days` model) — extend this function when changing the state schema so existing saved data doesn't break.
4. **Digital brain / capacity model** — `capacity(checkin)` converts today's check-in (energy/sleep/overload/mood) into an energy-points budget; `planDay()` greedily fills that budget with tasks ordered by priority (`essencial` > `importante` > `opcional`) then cost (`leve`/`medio`/`pesado`), pushing overflow into "later". `dayCurve()` projects an energy curve across the day per neurodivergent profile (`CURVE` constants).
5. **Task model** — two kinds: `rotina` (recurring, tied to weekdays via `days: []`, resets daily via `lastDone`) and `avulsa` (one-off, tied to `done`/`doneAt`). Tasks can have `steps` (checklist sub-items); completing all steps auto-completes the task and vice versa (`toggleDone`/`toggleStep`/`setDone`).
6. **Onboarding** — a 5-step wizard (`steps[]` array of render functions + `draft` object) shown after signup/login when `state.onboarded` is false; `draft.email`/`draft.name` are pre-filled from the account. `collectStep()` validates/collects each step before advancing.
7. **Screens/router** — six screens (`hoje`, `rotina`, `checkin`, `historico`, `planos`, `perfil`), each with a `render<Name>()` function registered in the `RENDER` map. `go(name)` swaps visible `<section id="screen-*">`, updates the tab bar, and syncs `location.hash` (`#/hoje` etc.); `hashchange` and initial `boot()` also drive routing. There is no virtual DOM — each `render*()` re-generates its screen's `innerHTML` from `state` and re-attaches event listeners on every call.
8. **Checkout / Premium** — `renderSheet()` drives a modal bottom-sheet checkout flow (plan tiers → payment step incl. a fake PIX code → success), gating features behind `state.user.plan === "premium"` via the `.locked`/`.locked__veil` CSS pattern. `TIERS` holds the three price points, including `padrinho` (R$19.90) — `state.user.tier` stores the chosen tier's *price*, not its id (an existing quirk; match it rather than "fixing" it in isolation).
9. **Padrinhos (sponsorship UI)** — `sponsorCardsHTML(u)`/`bindSponsorCards()`, called from `renderPerfil()`, render up to three cards depending on `state.user`: a pending invite to accept/decline, a "you're sponsored by X" card with a leave button, and — for a Padrinho-tier user (or anyone still managing an existing `sponsoring` relationship after downgrading, see `isPadrinhoNow || u.sponsoring`) — an invite-by-code form or the current invite's pending/active status. Every button hits the matching `/api/sponsor/*` route then calls `refreshAccountMeta()` + `renderPerfil()`.
10. **Boot** — `boot()` calls `GET /api/me`; on success it hands the account straight to `afterAuth()`, otherwise it shows the sign-in screen.

When adding a feature, follow the existing pattern: mutate `state`, call `persist()`, then re-invoke the current screen's `render*()` (or `go(route)`) to reflect it — there's no reactivity system.

## Design tokens

Both files share the same visual language (defined independently in each file's `:root`): dark blue backgrounds (`--ink-800`/`--ink-900`/`--ink-950`), a lime-green accent (`--lime-400`) for primary actions and highlights, `Archivo Black` for display headings and `Archivo` for body text. Keep new UI consistent with these tokens rather than introducing new colors/fonts.
