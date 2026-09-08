const fs = require('node:fs');
const path = require('node:path');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function startedAtFor(room) {
  if (room.matchStartedAt) return room.matchStartedAt;
  const event = (room.events || []).find(item => item.type === 'start' && item.details?.matchId === room.matchId);
  return event?.at || room.updatedAt || Date.now();
}

function playerMatchStats(room, player) {
  const events = (room.events || []).filter(event => event.details?.actorId === player.id);
  return {
    bankedPoints: Number.isFinite(player.matchBanked)
      ? player.matchBanked
      : events.filter(event => event.type === 'bank' || event.type === 'win').reduce((sum, event) => sum + Number(event.details?.amount || 0), 0),
    freezesUsed: Number.isFinite(player.matchFreezes)
      ? player.matchFreezes
      : events.filter(event => event.type === 'freeze').length
  };
}

class PostgresStore {
  constructor(connectionString, options = {}) {
    this.connectionString = connectionString;
    this.schemaPath = options.schemaPath || path.join(__dirname, 'database', 'schema.sql');
    this.ssl = options.ssl;
    this.pool = null;
    this.pendingSnapshot = null;
    this.snapshotFlush = null;
    this.operationQueue = Promise.resolve();
  }

  get enabled() {
    return Boolean(this.connectionString);
  }

  async initialize() {
    if (!this.enabled) return { rooms: [], retiredRooms: [] };
    const { Pool } = require('pg');
    this.pool = new Pool({ connectionString: this.connectionString, ssl: this.ssl });
    const schema = fs.readFileSync(this.schemaPath, 'utf8');
    try {
      await this.pool.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
      );
      const applied = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version = '001_v310'");
      if (!applied.rowCount) {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(schema);
          await client.query("INSERT INTO schema_migrations (version) VALUES ('001_v310')");
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
      const result = await this.pool.query('SELECT rooms, retired_rooms FROM app_state WHERE id = TRUE');
      const state = result.rows[0] || {};
      return {
        rooms: Array.isArray(state.rooms) ? state.rooms : [],
        retiredRooms: Array.isArray(state.retired_rooms) ? state.retired_rooms : []
      };
    } catch (error) {
      await this.pool.end().catch(() => {});
      this.pool = null;
      throw error;
    }
  }

  queueSnapshot(rooms, retiredRooms) {
    if (!this.enabled || !this.pool) return Promise.resolve();
    this.pendingSnapshot = { rooms: clone(rooms), retiredRooms: clone(retiredRooms) };
    if (!this.snapshotFlush) {
      this.snapshotFlush = this.enqueue(async () => {
        while (this.pendingSnapshot) {
          const snapshot = this.pendingSnapshot;
          this.pendingSnapshot = null;
          await this.pool.query(
            `INSERT INTO app_state (id, rooms, retired_rooms, updated_at)
             VALUES (TRUE, $1::jsonb, $2::jsonb, NOW())
             ON CONFLICT (id) DO UPDATE
             SET rooms = EXCLUDED.rooms, retired_rooms = EXCLUDED.retired_rooms, updated_at = NOW()`,
            [JSON.stringify(snapshot.rooms), JSON.stringify(snapshot.retiredRooms)]
          );
        }
      }).finally(() => {
        this.snapshotFlush = null;
        if (this.pendingSnapshot) this.queueSnapshot(this.pendingSnapshot.rooms, this.pendingSnapshot.retiredRooms);
      });
    }
    return this.snapshotFlush;
  }

  recordMatch(room) {
    if (!this.enabled || !this.pool || room.phase !== 'finished') return Promise.resolve();
    const completed = clone(room);
    return this.enqueue(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const winner = completed.players.find(player => player.id === completed.winnerId);
        const matchResult = await client.query(
          `INSERT INTO matches
             (room_code, match_number, mode, target_score, started_at, ended_at,
              winner_player_id, winner_name, winner_score)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (room_code, match_number) DO UPDATE SET
             mode = EXCLUDED.mode,
             target_score = EXCLUDED.target_score,
             ended_at = EXCLUDED.ended_at,
             winner_player_id = EXCLUDED.winner_player_id,
             winner_name = EXCLUDED.winner_name,
             winner_score = EXCLUDED.winner_score
           RETURNING id`,
          [
            completed.code,
            completed.matchId,
            completed.mode || 'classic',
            completed.targetScore || null,
            new Date(startedAtFor(completed)),
            new Date(completed.updatedAt || Date.now()),
            winner?.id || null,
            winner?.name || null,
            winner?.score || null
          ]
        );
        const matchId = matchResult.rows[0].id;

        await client.query('DELETE FROM match_players WHERE match_id = $1', [matchId]);
        for (const player of completed.players) {
          const matchStats = playerMatchStats(completed, player);
          await client.query(
            `INSERT INTO match_players
               (match_id, player_id, profile_id, player_name, final_score, rolls, busts, best_bank,
                banked_points, freezes_used, is_winner)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              matchId,
              player.id,
              player.profileId || null,
              player.name,
              player.score || 0,
              player.stats?.rolls || 0,
              player.stats?.busts || 0,
              player.stats?.bestBank || 0,
              matchStats.bankedPoints,
              matchStats.freezesUsed,
              player.id === completed.winnerId
            ]
          );
        }

        await client.query('DELETE FROM match_events WHERE match_id = $1', [matchId]);
        for (const event of completed.events || []) {
          await client.query(
            `INSERT INTO match_events
               (event_id, match_id, event_type, occurred_at, actor_id, target_id,
                amount, die, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
            [
              event.id,
              matchId,
              event.type,
              new Date(event.at),
              event.details?.actorId || null,
              event.details?.targetId || null,
              Number.isFinite(event.details?.amount) ? event.details.amount : null,
              Number.isFinite(event.details?.die) ? event.details.die : null,
              JSON.stringify(event.details || {})
            ]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async records(limit = 100) {
    if (!this.enabled || !this.pool) {
      return { configured: false, summary: { matches: 0, players: 0, rolls: 0, busts: 0 }, recent: [], leaderboard: [] };
    }
    const safeLimit = Math.floor(Math.min(500, Math.max(1, Number(limit) || 100)));
    const [summary, recent, leaderboard] = await Promise.all([
      this.pool.query(`SELECT COUNT(DISTINCT m.id)::int AS matches,
                              COUNT(DISTINCT mp.player_id)::int AS players,
                              COALESCE(SUM(mp.rolls), 0)::int AS rolls,
                              COALESCE(SUM(mp.busts), 0)::int AS busts
                       FROM matches m LEFT JOIN match_players mp ON mp.match_id = m.id`),
      this.pool.query(`SELECT id, room_code, match_number, mode, target_score, started_at,
                              ended_at, winner_name, winner_score
                       FROM matches ORDER BY ended_at DESC LIMIT $1`, [safeLimit]),
      this.pool.query('SELECT * FROM access_reporting.player_leaderboard ORDER BY wins DESC, games_played DESC, total_banked_points DESC LIMIT $1', [safeLimit])
    ]);
    return { configured: true, summary: summary.rows[0], recent: recent.rows, leaderboard: leaderboard.rows };
  }

  async accessRows(limit = 5000) {
    if (!this.enabled || !this.pool) return [];
    const safeLimit = Math.floor(Math.min(20_000, Math.max(1, Number(limit) || 5000)));
    const result = await this.pool.query('SELECT * FROM access_reporting.match_records ORDER BY ended_at DESC, player_name LIMIT $1', [safeLimit]);
    return result.rows;
  }

  async close() {
    if (this.snapshotFlush) await this.snapshotFlush;
    await this.operationQueue;
    if (this.pool) await this.pool.end();
  }

  enqueue(operation) {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.catch(error => {
      console.error('PostgreSQL operation failed:', error.message);
    });
    return result;
  }
}

function createPostgresStore(env = process.env) {
  const sslMode = String(env.DATABASE_SSL || '').toLowerCase();
  const sslRequested = ['1', 'true', 'require', 'verify', 'no-verify'].includes(sslMode);
  return new PostgresStore(env.DATABASE_URL || '', {
    ssl: sslRequested ? { rejectUnauthorized: sslMode !== 'no-verify' } : undefined
  });
}

module.exports = { PostgresStore, createPostgresStore };
