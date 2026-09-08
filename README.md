# Dice Night Royale V3.1

A server-authoritative multiplayer dice game for 2-9 players plus 20 spectators.

## Run locally

Install dependencies with `npm install`, then run `npm start`. The default address is `http://localhost:4173`.

Rooms, profiles, achievements, and completed match records are saved locally under `data/`. Back up that folder to preserve everything when moving the server to another computer.

## V3.1 Night League highlights

- Public live leaderboard with privacy-safe profile rankings, XP, levels, wins, and achievements
- Autonomous practice bots with multiple play styles for testing or filling a table
- New Five-Round Showdown: five turns per player, highest score wins, and only tied leaders enter sudden death
- New Battle Dice game: every player starts with 30 health and the last player standing wins
- Classic, Blitz, and Marathon modes, all using the requested 10-second turn clock by default
- Two visible dice on every turn: a safer Normal Die or a deadly Risk Die with 10/20/30 rewards and five or more skull faces
- Guaranteed server-side winner detection, a full-screen recap, confetti, and an original victory theme
- Always-visible event feed, score progress, chat, reactions, spectators, and saved room progress
- Optional player profiles with a profile code, six-digit PIN, lifetime statistics, and achievements
- Animated honorary profile titles, including FALCON Founder and ×4 Dice Night Champion
- Expanded Falcon Admin Panel with a saved-user list, profile editing/removal, and leaderboard reset
- Short, readable player names capped at 10 characters
- Responsive layouts tuned separately for phones and large desktop tables
- Lightweight local JSON storage with no separate database installation

Falcon controls are disabled unless `ENABLE_ADMIN=1` and `ADMIN_TOKEN` are set. Never commit the real token or the private `data/` files.

The live server is authoritative. Keep the process running while friends play and back up `data/` between hosting computers.
