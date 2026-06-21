# vwapp

A personal app to monitor and control a 2025 VW ID. Buzz.

It is an independent re-implementation of Volkswagen's official **myVW** iOS app
([App Store](https://apps.apple.com/us/app/myvw/id1481486650)). Rather than
reusing any of that app's code, it talks to the same VW backend servers — the
North America Car-Net cluster — by speaking the protocol reverse-engineered from
the stock app. The goal is the same core experience (vehicle status, lock/unlock,
charging, climate, parked location) in a small, self-hosted stack the owner
fully controls.

> Not affiliated with, endorsed by, or supported by Volkswagen. "myVW", "VW",
> and "ID. Buzz" are trademarks of Volkswagen AG, used here for reference only.

## What it does

- Live vehicle status: lock state, range, odometer, state of charge, charging
  state, and plug status
- Remote lock / unlock (S-PIN gated)
- Charging controls (start/stop, charge limit) and climate pre-conditioning
- Parked-location map and door/window detail
- Server-side polling so the dashboard stays fresh without the app open

## Architecture

pnpm monorepo:

- `app/` — Expo (SDK 56) + expo-router + Tamagui mobile app, runs in Expo Go
- `backend/` — Cloudflare Worker (oRPC) that owns the VW session and is the only
  writer to the database
- `packages/contract` — shared oRPC contract
- `packages/db` — shared InstantDB schema
- `packages/poc` — throwaway reference implementation of the VW protocol

The Worker holds a single VW session per account and polls VW on a cron; the app
reads vehicle data via InstantDB live queries for real-time updates and uses RPC
only for actions (login/logout/refresh/commands).

## Development

```bash
pnpm test                              # typecheck + lint (run before committing)
pnpm --filter @vwapp/backend dev       # Worker on localhost:8787
pnpm --filter @vwapp/mobile start      # Expo dev server
```

See [CLAUDE.md](./CLAUDE.md) for the full architecture, the VW protocol details,
deployment, and project conventions, and [TODO.md](./TODO.md) for planned work.

## Deploy your own instance

Nothing owner-specific is committed — every account/identity value comes from
environment files you create from the provided `*.example` templates. You need a
North America (myVW / legacy Car-Net) VW account; the EU CARIAD stack is not
supported. Apple Maps (the parked-location map) is **optional** — skip it and the
app simply shows coordinates instead.

1. **InstantDB** — create an app at [instantdb.com](https://instantdb.com) and
   grab its app id + admin token. Copy `backend/.dev.vars.example` →
   `backend/.dev.vars` and fill in `INSTANT_APP_ID`, `INSTANT_ADMIN_TOKEN`, and a
   fresh `CREDS_ENC_KEY` (`openssl rand -base64 32`). Push the schema/perms:
   ```bash
   cd backend
   set -a && source .dev.vars && set +a && npx instant-cli push schema --yes
   set -a && source .dev.vars && set +a && npx instant-cli push perms --yes
   ```
2. **VW credentials** — copy `.env.example` → `.env` and fill in your
   `VW_USERNAME` / `VW_PASSWORD` / `VW_PIN`.
3. **Cloudflare Worker** — copy `backend/.env.example` → `backend/.env` and set
   `CLOUDFLARE_ACCOUNT_ID` (auto-sourced by the deploy script). Then from
   `backend/`:
   ```bash
   npx wrangler secret bulk .dev.vars              # push secrets to the Worker
   pnpm --filter @vwapp/backend deploy             # → vwapp-api.<your-subdomain>.workers.dev
   ```
4. **Mobile app** — copy `app/.env.example` → `app/.env` and set
   `EXPO_PUBLIC_INSTANT_APP_ID`, `EXPO_PUBLIC_API_URL` (your deployed Worker URL,
   ending in `/rpc`), plus `EXPO_OWNER` / `EAS_PROJECT_ID` /
   `IOS_BUNDLE_IDENTIFIER` for publishing. Initialise EAS and publish an update
   for Expo Go:
   ```bash
   cd app
   npx eas-cli init                     # creates the EAS project (sets EAS_PROJECT_ID)
   npx eas-cli update --branch main --message "initial" --environment production
   ```
   For local development you can skip `EXPO_PUBLIC_API_URL`: with the Metro and
   Worker dev servers running, the app auto-targets the Worker on the same host.

**Optional — parked-location map:** add `APPLE_MAPS_TEAM_ID`,
`APPLE_MAPS_KEY_ID`, and `APPLE_MAPS_PRIVATE_KEY` (an Apple Developer MapKit JS
`.p8` key) to `backend/.dev.vars` and re-push secrets.
