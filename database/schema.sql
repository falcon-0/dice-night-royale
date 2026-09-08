CREATE TABLE IF NOT EXISTS app_state (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
  rooms JSONB NOT NULL DEFAULT '[]'::jsonb,
  retired_rooms JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE SCHEMA IF NOT EXISTS access_reporting;

CREATE TABLE IF NOT EXISTS player_profiles (
  id TEXT PRIMARY KEY,
  profile_code VARCHAR(8) UNIQUE NOT NULL,
  display_name VARCHAR(64) NOT NULL,
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  total_rolls INTEGER NOT NULL DEFAULT 0,
  total_busts INTEGER NOT NULL DEFAULT 0,
  best_bank INTEGER NOT NULL DEFAULT 0,
  total_banked INTEGER NOT NULL DEFAULT 0,
  total_freezes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profile_sessions (
  token_hash TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS profile_sessions_expiry_idx ON profile_sessions (expires_at);

CREATE TABLE IF NOT EXISTS profile_matches (
  profile_id TEXT NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  room_code VARCHAR(12) NOT NULL,
  match_number INTEGER NOT NULL,
  PRIMARY KEY (profile_id, room_code, match_number)
);

CREATE TABLE IF NOT EXISTS profile_achievements (
  profile_id TEXT NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  achievement_key VARCHAR(40) NOT NULL,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  room_code VARCHAR(12),
  match_number INTEGER,
  PRIMARY KEY (profile_id, achievement_key)
);

CREATE TABLE IF NOT EXISTS matches (
  id BIGSERIAL PRIMARY KEY,
  room_code VARCHAR(12) NOT NULL,
  match_number INTEGER NOT NULL,
  mode VARCHAR(24) NOT NULL,
  target_score INTEGER,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  winner_player_id TEXT,
  winner_name VARCHAR(64),
  winner_score INTEGER,
  UNIQUE (room_code, match_number)
);

CREATE INDEX IF NOT EXISTS matches_ended_at_idx ON matches (ended_at DESC);

CREATE TABLE IF NOT EXISTS match_players (
  match_id BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  player_name VARCHAR(64) NOT NULL,
  final_score INTEGER NOT NULL DEFAULT 0,
  rolls INTEGER NOT NULL DEFAULT 0,
  busts INTEGER NOT NULL DEFAULT 0,
  best_bank INTEGER NOT NULL DEFAULT 0,
  banked_points INTEGER NOT NULL DEFAULT 0,
  freezes_used INTEGER NOT NULL DEFAULT 0,
  is_winner BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (match_id, player_id)
);

ALTER TABLE match_players ADD COLUMN IF NOT EXISTS profile_id TEXT;

CREATE INDEX IF NOT EXISTS match_players_player_idx ON match_players (player_id);

CREATE TABLE IF NOT EXISTS match_events (
  event_id TEXT PRIMARY KEY,
  match_id BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  event_type VARCHAR(32) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  actor_id TEXT,
  target_id TEXT,
  amount INTEGER,
  die INTEGER,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS match_events_match_idx ON match_events (match_id, occurred_at);

CREATE OR REPLACE VIEW access_reporting.match_records AS
SELECT
  m.id AS match_record_id,
  m.room_code,
  m.match_number,
  m.mode,
  m.target_score,
  m.started_at,
  m.ended_at,
  m.winner_name,
  m.winner_score,
  mp.player_id,
  mp.profile_id,
  mp.player_name,
  mp.final_score,
  mp.rolls,
  mp.busts,
  mp.best_bank,
  mp.banked_points,
  mp.freezes_used,
  mp.is_winner
FROM matches m
JOIN match_players mp ON mp.match_id = m.id;

CREATE OR REPLACE VIEW access_reporting.player_leaderboard AS
SELECT
  p.profile_code,
  p.display_name AS player_name,
  p.xp,
  p.games AS games_played,
  p.wins,
  p.total_rolls AS total_rolls,
  p.total_busts AS total_busts,
  p.best_bank,
  p.total_banked AS total_banked_points,
  p.total_freezes AS total_freezes_used,
  p.created_at,
  p.last_seen_at
FROM player_profiles p;

CREATE OR REPLACE VIEW access_reporting.profile_achievements AS
SELECT
  p.profile_code,
  p.display_name,
  a.achievement_key,
  a.unlocked_at,
  a.room_code,
  a.match_number
FROM profile_achievements a
JOIN player_profiles p ON p.id = a.profile_id;
