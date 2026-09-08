const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

const ACHIEVEMENTS = Object.freeze({
  profile_created: { name: 'Founding Player', icon: '◆', description: 'Create a permanent player profile.' },
  first_match: { name: 'First Night', icon: '🎲', description: 'Complete your first match.' },
  first_win: { name: 'Crowned', icon: '🏆', description: 'Win your first match.' },
  hot_hand: { name: 'Hot Hand', icon: '🔥', description: 'Bank 25 or more points at once.' },
  dice_regular: { name: 'Dice Regular', icon: '⚡', description: 'Roll the dice 50 times.' },
  bank_builder: { name: 'Bank Builder', icon: '💰', description: 'Bank 250 lifetime points.' },
  champion: { name: 'Table Champion', icon: '♛', description: 'Win five matches.' },
  ice_master: { name: 'Ice Master', icon: '❄', description: 'Use Freeze ten times.' },
  fearless: { name: 'Fearless', icon: '💥', description: 'Survive 25 lifetime busts.' }
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanDisplayName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 18);
}

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 8);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function levelFor(xp) {
  return Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / 200)) + 1);
}

function profileCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(8), byte => alphabet[byte % alphabet.length]).join('');
}

async function pinHash(pin, salt) {
  return (await scrypt(pin, salt, 32)).toString('hex');
}

function matchStats(room, player) {
  const events = (room.events || []).filter(event => event.details?.actorId === player.id);
  const banked = events
    .filter(event => event.type === 'bank' || event.type === 'win')
    .reduce((sum, event) => sum + Number(event.details?.amount || 0), 0);
  return {
    games: 1,
    wins: player.id === room.winnerId ? 1 : 0,
    rolls: player.stats?.rolls || 0,
    busts: player.stats?.busts || 0,
    bestBank: player.stats?.bestBank || 0,
    banked: Number.isFinite(player.matchBanked) ? player.matchBanked : banked,
    freezes: Number.isFinite(player.matchFreezes) ? player.matchFreezes : events.filter(event => event.type === 'freeze').length
  };
}

function earnedKeys(profile) {
  const keys = ['profile_created'];
  if (profile.games >= 1) keys.push('first_match');
  if (profile.wins >= 1) keys.push('first_win');
  if (profile.bestBank >= 25) keys.push('hot_hand');
  if (profile.totalRolls >= 50) keys.push('dice_regular');
  if (profile.totalBanked >= 250) keys.push('bank_builder');
  if (profile.wins >= 5) keys.push('champion');
  if (profile.totalFreezes >= 10) keys.push('ice_master');
  if (profile.totalBusts >= 25) keys.push('fearless');
  return keys;
}

class ProfileService {
  constructor(database, options = {}) {
    this.database = database;
    this.file = options.file || process.env.PROFILE_FILE || path.join(__dirname, 'data', 'profiles.json');
    this.local = { profiles: [], sessions: [], achievements: [], completedMatches: [] };
  }

  async initialize() {
    if (this.database.enabled) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.local = {
        profiles: Array.isArray(saved.profiles) ? saved.profiles : [],
        sessions: Array.isArray(saved.sessions) ? saved.sessions : [],
        achievements: Array.isArray(saved.achievements) ? saved.achievements : [],
        completedMatches: Array.isArray(saved.completedMatches) ? saved.completedMatches : []
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  persistLocal() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.local, null, 2));
  }

  async create(displayNameValue, pin) {
    const displayName = cleanDisplayName(displayNameValue);
    if (!displayName) throw Object.assign(new Error('Choose a profile name.'), { status: 400 });
    if (!/^\d{6}$/.test(String(pin || ''))) throw Object.assign(new Error('Choose a 6-digit profile PIN.'), { status: 400 });
    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await pinHash(String(pin), salt);
    let code = profileCode();
    if (this.database.enabled) {
      while ((await this.database.pool.query('SELECT 1 FROM player_profiles WHERE profile_code = $1', [code])).rowCount) code = profileCode();
      await this.database.pool.query(
        `INSERT INTO player_profiles
           (id, profile_code, display_name, pin_salt, pin_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, code, displayName, salt, hash]
      );
      await this.database.pool.query(
        `INSERT INTO profile_achievements (profile_id, achievement_key, unlocked_at)
         VALUES ($1, 'profile_created', NOW()) ON CONFLICT DO NOTHING`,
        [id]
      );
    } else {
      while (this.local.profiles.some(profile => profile.profileCode === code)) code = profileCode();
      this.local.profiles.push({
        id, profileCode: code, displayName, pinSalt: salt, pinHash: hash,
        xp: 0, games: 0, wins: 0, totalRolls: 0, totalBusts: 0,
        bestBank: 0, totalBanked: 0, totalFreezes: 0,
        createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString()
      });
      this.local.achievements.push({ profileId: id, key: 'profile_created', unlockedAt: new Date().toISOString() });
      this.persistLocal();
    }
    return this.issueSession(id);
  }

  async login(codeValue, pin) {
    const code = normalizeCode(codeValue);
    const profile = await this.findByCode(code);
    if (!profile || !/^\d{6}$/.test(String(pin || ''))) {
      throw Object.assign(new Error('Profile code or PIN is incorrect.'), { status: 401 });
    }
    const supplied = Buffer.from(await pinHash(String(pin), profile.pinSalt), 'hex');
    const expected = Buffer.from(profile.pinHash, 'hex');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      throw Object.assign(new Error('Profile code or PIN is incorrect.'), { status: 401 });
    }
    return this.issueSession(profile.id);
  }

  async issueSession(profileId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = tokenHash(token);
    const expiresAt = new Date(Date.now() + SESSION_MS);
    if (this.database.enabled) {
      await this.database.pool.query(
        'INSERT INTO profile_sessions (token_hash, profile_id, expires_at) VALUES ($1, $2, $3)',
        [hash, profileId, expiresAt]
      );
    } else {
      this.local.sessions = this.local.sessions.filter(session => new Date(session.expiresAt).getTime() > Date.now());
      this.local.sessions.push({ tokenHash: hash, profileId, expiresAt: expiresAt.toISOString() });
      this.persistLocal();
    }
    return { profileToken: token, profile: await this.byId(profileId) };
  }

  async authenticate(token) {
    if (!token) return null;
    const hash = tokenHash(token);
    let profileId;
    if (this.database.enabled) {
      const result = await this.database.pool.query(
        'SELECT profile_id FROM profile_sessions WHERE token_hash = $1 AND expires_at > NOW()',
        [hash]
      );
      profileId = result.rows[0]?.profile_id;
    } else {
      profileId = this.local.sessions.find(session => session.tokenHash === hash && new Date(session.expiresAt).getTime() > Date.now())?.profileId;
    }
    if (!profileId) throw Object.assign(new Error('Your profile login expired. Sign in again.'), { status: 401 });
    return this.byId(profileId);
  }

  async findByCode(code) {
    if (this.database.enabled) {
      const result = await this.database.pool.query('SELECT * FROM player_profiles WHERE profile_code = $1', [code]);
      return result.rows[0] ? this.fromRow(result.rows[0], true) : null;
    }
    const profile = this.local.profiles.find(item => item.profileCode === code);
    return profile ? clone(profile) : null;
  }

  async byId(id) {
    let profile;
    let achievements;
    if (this.database.enabled) {
      const [profileResult, achievementResult] = await Promise.all([
        this.database.pool.query('SELECT * FROM player_profiles WHERE id = $1', [id]),
        this.database.pool.query('SELECT achievement_key, unlocked_at FROM profile_achievements WHERE profile_id = $1 ORDER BY unlocked_at', [id])
      ]);
      if (!profileResult.rows[0]) return null;
      profile = this.fromRow(profileResult.rows[0]);
      achievements = achievementResult.rows.map(row => ({ key: row.achievement_key, unlockedAt: row.unlocked_at }));
    } else {
      const found = this.local.profiles.find(item => item.id === id);
      if (!found) return null;
      profile = clone(found);
      achievements = this.local.achievements.filter(item => item.profileId === id).map(item => ({ key: item.key, unlockedAt: item.unlockedAt }));
    }
    return this.publicProfile(profile, achievements);
  }

  fromRow(row, includePin = false) {
    const profile = {
      id: row.id,
      profileCode: row.profile_code,
      displayName: row.display_name,
      xp: row.xp,
      games: row.games,
      wins: row.wins,
      totalRolls: row.total_rolls,
      totalBusts: row.total_busts,
      bestBank: row.best_bank,
      totalBanked: row.total_banked,
      totalFreezes: row.total_freezes,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at
    };
    if (includePin) {
      profile.pinSalt = row.pin_salt;
      profile.pinHash = row.pin_hash;
    }
    return profile;
  }

  publicProfile(profile, achievements = []) {
    return {
      id: profile.id,
      profileCode: profile.profileCode,
      displayName: profile.displayName,
      xp: Number(profile.xp || 0),
      level: levelFor(profile.xp),
      stats: {
        games: Number(profile.games || 0),
        wins: Number(profile.wins || 0),
        totalRolls: Number(profile.totalRolls || 0),
        totalBusts: Number(profile.totalBusts || 0),
        bestBank: Number(profile.bestBank || 0),
        totalBanked: Number(profile.totalBanked || 0),
        totalFreezes: Number(profile.totalFreezes || 0)
      },
      achievements: achievements.map(item => ({
        key: item.key,
        unlockedAt: item.unlockedAt,
        ...ACHIEVEMENTS[item.key]
      }))
    };
  }

  async completeMatch(room) {
    const profiledPlayers = room.players.filter(player => player.profileId);
    for (const player of profiledPlayers) {
      const matchKey = `${player.profileId}:${room.code}:${room.matchId}`;
      const stats = matchStats(room, player);
      const xp = 100 + stats.rolls * 5 + stats.banked + stats.wins * 150;
      if (this.database.enabled) {
        const client = await this.database.pool.connect();
        try {
          await client.query('BEGIN');
          const inserted = await client.query(
            `INSERT INTO profile_matches (profile_id, room_code, match_number)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING profile_id`,
            [player.profileId, room.code, room.matchId]
          );
          if (!inserted.rowCount) {
            await client.query('ROLLBACK');
            continue;
          }
          const updated = await client.query(
            `UPDATE player_profiles SET
               xp = xp + $2, games = games + 1, wins = wins + $3,
               total_rolls = total_rolls + $4, total_busts = total_busts + $5,
               best_bank = GREATEST(best_bank, $6), total_banked = total_banked + $7,
               total_freezes = total_freezes + $8, last_seen_at = NOW()
             WHERE id = $1 RETURNING *`,
            [player.profileId, xp, stats.wins, stats.rolls, stats.busts, stats.bestBank, stats.banked, stats.freezes]
          );
          const earned = earnedKeys(this.fromRow(updated.rows[0]));
          for (const key of earned) {
            await client.query(
              `INSERT INTO profile_achievements
                 (profile_id, achievement_key, unlocked_at, room_code, match_number)
               VALUES ($1, $2, NOW(), $3, $4) ON CONFLICT DO NOTHING`,
              [player.profileId, key, room.code, room.matchId]
            );
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } else {
        if (this.local.completedMatches.includes(matchKey)) continue;
        const profile = this.local.profiles.find(item => item.id === player.profileId);
        if (!profile) continue;
        profile.xp += xp;
        profile.games += 1;
        profile.wins += stats.wins;
        profile.totalRolls += stats.rolls;
        profile.totalBusts += stats.busts;
        profile.bestBank = Math.max(profile.bestBank, stats.bestBank);
        profile.totalBanked += stats.banked;
        profile.totalFreezes += stats.freezes;
        profile.lastSeenAt = new Date().toISOString();
        const existing = new Set(this.local.achievements.filter(item => item.profileId === profile.id).map(item => item.key));
        for (const key of earnedKeys(profile)) {
          if (!existing.has(key)) this.local.achievements.push({ profileId: profile.id, key, unlockedAt: new Date().toISOString(), roomCode: room.code, matchNumber: room.matchId });
        }
        this.local.completedMatches.push(matchKey);
        this.persistLocal();
      }
    }
  }
}

module.exports = { ProfileService, ACHIEVEMENTS, cleanDisplayName, normalizeCode, levelFor };
