# Dice Night Royale 3.0

A dependency-free, server-authoritative multiplayer dice game for 2–9 players plus 20 spectators.

## Run the staging build

```powershell
$env:PORT=4174
npm start
```

Rooms and progress are persisted in `data/rooms.json`. Browser snapshots are intentionally rejected; the server is authoritative.

Royale includes Classic, Blitz, and Marathon modes; ready checks; live spectators; emoji reactions; room chat; a structured match timeline; final awards; persistent room records; rejoin by room code and saved name; escalating bust risk; Safety Nets; Hot Streaks; Double Roll; and once-per-turn Freeze.

The private FALCON control deck is disabled by default. Start with `ENABLE_ADMIN=1` and a private `ADMIN_TOKEN` to enable it.

Version 3 intentionally starts with fresh rooms. Legacy version-2 rooms should be retired during deployment because they do not have private rejoin credentials.
