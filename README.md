# Dice Night Royale 3.1

A server-authoritative multiplayer dice game for 2-9 players plus 20 spectators.

## Run locally

Install dependencies with `npm install`, then run `npm start`. The default address is `http://localhost:4173`.

Without `DATABASE_URL`, rooms and profiles are saved locally under `data/`. With `DATABASE_URL`, PostgreSQL becomes the primary live store and completed matches are written to permanent reporting tables.

## V3.1 highlights

- Optional player profiles with a profile code, six-digit PIN, XP, levels, lifetime statistics, and nine achievements
- Normal Die or deadly Risk Die choice; the Risk Die starts with five reward faces and five skull faces, then adds skulls
- PostgreSQL persistence, idempotent match archiving, history reconciliation, and Access-ready reporting views
- Falcon controls embedded directly in the normal game page
- UTF-8 CSV export for Microsoft Access
- Guest play, rejoin keys, chat, reactions, spectators, three modes, awards, and room records remain available

Falcon controls are disabled unless `ENABLE_ADMIN=1` and `ADMIN_TOKEN` are set. Never commit the real token or database URL.

See `docs/MICROSOFT_ACCESS.md` for the Access reporting connection.
