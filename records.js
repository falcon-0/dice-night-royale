const path = require('node:path');
const { readJsonFile, writeJsonFile } = require('./json-store');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function startedAtFor(room) {
  if (room.matchStartedAt) return room.matchStartedAt;
  const event = (room.events || []).find(item => item.type === 'start' && item.details?.matchId === room.matchId);
  return event?.at || room.updatedAt || Date.now();
}

function playerStats(room, player) {
  const events = (room.events || []).filter(event => event.details?.actorId === player.id);
  return {
    bankedPoints: Number.isFinite(player.matchBanked)
      ? player.matchBanked
      : events.filter(event => event.type === 'bank' || event.type === 'win')
        .reduce((sum, event) => sum + Number(event.details?.amount || 0), 0),
    freezesUsed: Number.isFinite(player.matchFreezes)
      ? player.matchFreezes
      : events.filter(event => event.type === 'freeze').length
  };
}

class LocalRecordStore {
  constructor(options = {}) {
    this.file = options.file || process.env.RECORDS_FILE || path.join(__dirname, 'data', 'matches.json');
    this.matches = [];
  }

  async initialize() {
    const saved = readJsonFile(this.file, []);
    this.matches = Array.isArray(saved) ? saved : [];
  }

  persist() {
    writeJsonFile(this.file, this.matches);
  }

  async recordMatch(room) {
    if (room.phase !== 'finished') return;
    const completed = clone(room);
    const winner = completed.players.find(player => player.id === completed.winnerId);
    const record = {
      id: `${completed.code}:${completed.matchId}`,
      roomCode: completed.code,
      matchNumber: completed.matchId,
      mode: completed.mode || 'classic',
      targetScore: completed.targetScore || null,
      startedAt: new Date(startedAtFor(completed)).toISOString(),
      endedAt: new Date(completed.updatedAt || Date.now()).toISOString(),
      winnerPlayerId: winner?.id || null,
      winnerName: winner?.name || null,
      winnerScore: winner?.score ?? null,
      players: completed.players.map(player => {
        const stats = playerStats(completed, player);
        return {
          playerId: player.id,
          profileId: player.profileId || null,
          playerName: player.name,
          finalScore: player.score || 0,
          rolls: player.stats?.rolls || 0,
          busts: player.stats?.busts || 0,
          bestBank: player.stats?.bestBank || 0,
          bankedPoints: stats.bankedPoints,
          freezesUsed: stats.freezesUsed,
          isWinner: player.id === completed.winnerId
        };
      })
    };
    const existingIndex = this.matches.findIndex(item => item.id === record.id);
    if (existingIndex >= 0) this.matches[existingIndex] = record;
    else this.matches.push(record);
    this.persist();
  }

  async records(limit = 100) {
    const safeLimit = Math.floor(Math.min(500, Math.max(1, Number(limit) || 100)));
    const allPlayers = this.matches.flatMap(match => match.players || []);
    const leaderboard = new Map();
    for (const player of allPlayers) {
      const key = player.profileId || player.playerName.toLocaleLowerCase();
      const current = leaderboard.get(key) || {
        player_name: player.playerName,
        games_played: 0,
        wins: 0,
        total_banked_points: 0
      };
      current.games_played += 1;
      current.wins += player.isWinner ? 1 : 0;
      current.total_banked_points += Number(player.bankedPoints || 0);
      leaderboard.set(key, current);
    }
    return {
      configured: true,
      summary: {
        matches: this.matches.length,
        players: new Set(allPlayers.map(player => player.profileId || player.playerName.toLocaleLowerCase())).size,
        rolls: allPlayers.reduce((sum, player) => sum + Number(player.rolls || 0), 0),
        busts: allPlayers.reduce((sum, player) => sum + Number(player.busts || 0), 0)
      },
      recent: [...this.matches]
        .sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt))
        .slice(0, safeLimit)
        .map(match => ({
          id: match.id,
          room_code: match.roomCode,
          match_number: match.matchNumber,
          mode: match.mode,
          target_score: match.targetScore,
          started_at: match.startedAt,
          ended_at: match.endedAt,
          winner_name: match.winnerName,
          winner_score: match.winnerScore
        })),
      leaderboard: [...leaderboard.values()]
        .sort((a, b) => b.wins - a.wins || b.games_played - a.games_played || b.total_banked_points - a.total_banked_points)
        .slice(0, safeLimit)
    };
  }

  async reset() {
    this.matches = [];
    this.persist();
  }

  async renameProfile(profileId, displayName) {
    let changed = false;
    for (const match of this.matches) {
      for (const player of match.players || []) {
        if (player.profileId !== profileId || player.playerName === displayName) continue;
        player.playerName = displayName;
        changed = true;
        if (match.winnerPlayerId === player.playerId) match.winnerName = displayName;
      }
    }
    if (changed) this.persist();
    return changed;
  }

  async removeProfiles(profileIds) {
    const removed = new Set(profileIds || []);
    if (!removed.size) return 0;
    const before = this.matches.length;
    this.matches = this.matches.filter(match => !(match.players || []).some(player => removed.has(player.profileId)));
    if (this.matches.length !== before) this.persist();
    return before - this.matches.length;
  }

  async close() {}
}

module.exports = { LocalRecordStore };
