const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { LocalRecordStore } = require('./records');
const { ProfileService, normalizeCode } = require('./profiles');
const { BOT_STYLES, availableBotName, botStyle, chooseBotAction } = require('./bots');
const { readJsonFile, writeJsonFile } = require('./json-store');

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';
const APP_VERSION = '3.1.0';
const MAX_PLAYERS = 9;
const TURN_MS = 10_000;
const MAX_SPECTATORS = 20;
const MODES = Object.freeze({
  classic: { id: 'classic', name: 'Classic', targetScore: 100, turnMs: 10_000, riskStart: 16, riskStep: 8, description: 'The balanced original' },
  blitz: { id: 'blitz', name: 'Blitz', targetScore: 50, turnMs: 10_000, riskStart: 20, riskStep: 10, description: 'Fast, loud, and dangerous' },
  marathon: { id: 'marathon', name: 'Marathon', targetScore: 200, turnMs: 10_000, riskStart: 12, riskStep: 6, description: 'Long game, deeper strategy' },
  showdown: { id: 'showdown', name: 'Five-Round Showdown', targetScore: null, turnMs: 10_000, riskStart: 16, riskStep: 8, description: 'Five turns each, then sudden death if tied' },
  battle: { id: 'battle', name: 'Battle Dice', targetScore: null, turnMs: 10_000, riskStart: 17, riskStep: 0, description: 'Attack rivals and be the last player standing' }
});
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const RETIRED_FILE = process.env.RETIRED_FILE || path.join(__dirname, 'data', 'retired-rooms.json');
const ADMIN_TOKEN_FILE = process.env.ADMIN_TOKEN_FILE || path.join(__dirname, 'data', 'admin-token.txt');
const ADMIN_ENABLED = process.env.ENABLE_ADMIN === '1';
const rooms = new Map();
const retiredRooms = new Set();
const publicDir = path.join(__dirname, 'public');
const recordsStore = new LocalRecordStore();
const profiles = new ProfileService();
const authAttempts = new Map();
const botPlans = new Map();

function loadAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  try {
    return fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = crypto.randomBytes(24).toString('base64url');
    fs.mkdirSync(path.dirname(ADMIN_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(ADMIN_TOKEN_FILE, token);
    return token;
  }
}

const ADMIN_TOKEN = ADMIN_ENABLED ? loadAdminToken() : '';

function persistRooms() {
  writeJsonFile(DATA_FILE, [...rooms.values()]);
}

function persistRetiredRooms() {
  writeJsonFile(RETIRED_FILE, [...retiredRooms]);
}

function loadSavedRooms(saved) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const room of saved) {
    if (room?.code && Array.isArray(room.players) && room.updatedAt > cutoff) {
        room.rollStreak ??= 0;
        room.lastRollKind ??= 'normal';
        room.lastReward ??= null;
        room.lastOutcome ??= null;
        room.freezeUsed ??= false;
        room.schemaVersion = 4;
        room.matchId ??= 0;
        room.matchStartedAt ??= null;
        room.matchArchived ??= room.phase !== 'finished';
        room.paused ??= false;
        room.turnDurationMs ??= TURN_MS;
        room.mode = MODES[room.mode] ? room.mode : 'classic';
        room.turnNumber ??= 0;
        room.showdownRoundLimit ??= 5;
        room.showdownSuddenDeath ??= false;
        room.showdownContenders = Array.isArray(room.showdownContenders) ? room.showdownContenders : [];
        room.departedPlayers = Array.isArray(room.departedPlayers) ? room.departedPlayers : [];
        room.spectators ??= [];
        room.reactions ??= [];
        room.events ??= [];
        room.chat ??= [];
        room.players.forEach(player => {
          player.shieldAvailable ??= true;
          player.frozen ??= false;
          player.stats ??= { rolls: 0, busts: 0, bestBank: 0 };
          player.ready ??= player.id === room.hostId;
          player.career ??= { games: 0, wins: 0, totalBanked: 0 };
          player.matchBanked ??= 0;
          player.matchFreezes ??= 0;
          player.turnsTaken ??= 0;
          player.isBot = Boolean(player.isBot);
          if (player.isBot) {
            player.botStyle = botStyle(player.botStyle).id;
            player.ready = true;
          }
          player.sessionToken ??= crypto.randomBytes(24).toString('base64url');
          player.rejoinCode ??= String(crypto.randomInt(100000, 1000000));
        });
        room.spectators.forEach(spectator => {
          spectator.sessionToken ??= crypto.randomBytes(24).toString('base64url');
          spectator.rejoinCode ??= String(crypto.randomInt(100000, 1000000));
        });
        room.turnDeadline = room.phase === 'playing' && !room.paused ? Date.now() + room.turnDurationMs : null;
        rooms.set(room.code, room);
    }
  }
}

function loadRooms() {
  loadSavedRooms(readJsonFile(DATA_FILE, []));
}

function loadRetiredRooms() {
  for (const code of readJsonFile(RETIRED_FILE, [])) retiredRooms.add(String(code).toUpperCase());
}

loadRooms();
loadRetiredRooms();

async function initializeStorage() {
  await recordsStore.initialize();
  await profiles.initialize();
  let reconciled = false;
  for (const room of rooms.values()) {
    const before = JSON.stringify({ phase: room.phase, winnerId: room.winnerId, showdownRoundLimit: room.showdownRoundLimit, showdownSuddenDeath: room.showdownSuddenDeath, showdownContenders: room.showdownContenders, eventCount: room.events?.length || 0 });
    const finished = reconcileWinner(room);
    const after = JSON.stringify({ phase: room.phase, winnerId: room.winnerId, showdownRoundLimit: room.showdownRoundLimit, showdownSuddenDeath: room.showdownSuddenDeath, showdownContenders: room.showdownContenders, eventCount: room.events?.length || 0 });
    if (finished || before !== after) {
      bump(room);
      reconciled = true;
    }
    if (room.phase === 'finished' && !room.matchArchived) {
      await archiveCompletedMatch(room).catch(error => console.error('Could not reconcile completed match:', error.message));
    }
  }
  if (reconciled) persistRooms();
}

function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(5), byte => alphabet[byte % alphabet.length]).join('');
  } while (rooms.has(code) || retiredRooms.has(code));
  return code;
}

function cleanName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 18);
}

function cleanMessage(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 160);
}

function modeFor(room) {
  return MODES[room.mode] || MODES.classic;
}

async function archiveCompletedMatch(room) {
  if (room.phase !== 'finished' || room.matchArchived) return;
  const departed = (room.departedPlayers || []).filter(player => !room.players.some(current => current.id === player.id));
  const completed = JSON.parse(JSON.stringify({ ...room, players: [...room.players, ...departed], targetScore: modeFor(room).targetScore }));
  await recordsStore.recordMatch(completed);
  await profiles.completeMatch(completed);
  const liveRoom = rooms.get(completed.code);
  if (!liveRoom || liveRoom.matchId !== completed.matchId || liveRoom.phase !== 'finished') return;
  for (const player of liveRoom.players) {
    if (player.profileId) player.profile = profileSummary(await profiles.byId(player.profileId));
  }
  liveRoom.matchArchived = true;
  persistRooms();
}

function identitySecrets() {
  return {
    sessionToken: crypto.randomBytes(24).toString('base64url'),
    rejoinCode: String(crypto.randomInt(100000, 1000000))
  };
}

function addEvent(room, type, text, details = {}) {
  room.events.push({ id: crypto.randomUUID(), type, text, details, at: Date.now() });
  room.events = room.events.slice(-80);
}

function profileSummary(profile) {
  if (!profile) return null;
  return {
    level: profile.level,
    achievements: (profile.achievements || []).slice(-3).map(item => ({ key: item.key, name: item.name, icon: item.icon }))
  };
}

function finishMatch(room, player, banked = 0) {
  if (room.phase !== 'playing' || room.winnerId) return false;
  room.phase = 'finished';
  room.winnerId = player.id;
  room.matchArchived = false;
  room.turnScore = 0;
  room.turnDeadline = null;
  room.message = room.mode === 'battle'
    ? `${player.name} is the last player standing with ${player.score} health!`
    : `${player.name} wins with ${player.score} points!`;
  room.players.forEach(candidate => {
    candidate.career ??= { games: 0, wins: 0, totalBanked: 0 };
    candidate.career.games += 1;
  });
  player.career.wins += 1;
  addEvent(room, 'win', room.message, { actorId: player.id, score: player.score, amount: banked, matchId: room.matchId });
  botPlans.delete(room.code);
  return true;
}

function reconcileShowdown(room) {
  if (room.phase !== 'playing' || room.mode !== 'showdown' || !room.players.length) return false;
  const roundLimit = Math.max(5, Number(room.showdownRoundLimit) || 5);
  const contenderIds = new Set(room.showdownSuddenDeath ? room.showdownContenders || [] : []);
  const eligible = contenderIds.size ? room.players.filter(player => contenderIds.has(player.id)) : room.players;
  if (!eligible.length || !eligible.every(player => Number(player.turnsTaken || 0) >= roundLimit)) return false;
  const highScore = Math.max(...eligible.map(player => player.score));
  const leaders = eligible.filter(player => player.score === highScore);
  if (leaders.length === 1) return finishMatch(room, leaders[0]);
  room.showdownSuddenDeath = true;
  room.showdownContenders = leaders.map(player => player.id);
  room.showdownRoundLimit = roundLimit + 1;
  room.message = `Sudden death! ${leaders.map(player => player.name).join(' and ')} get one more turn.`;
  addEvent(room, 'sudden_death', room.message, { round: room.showdownRoundLimit, tiedPlayerIds: leaders.map(player => player.id) });
  return false;
}

function reconcileBattle(room) {
  if (room.phase !== 'playing' || room.mode !== 'battle') return false;
  const standing = room.players.filter(player => Number(player.score) > 0);
  return standing.length === 1 ? finishMatch(room, standing[0]) : false;
}

function reconcileWinner(room, preferredPlayer = null, banked = 0) {
  if (room.phase !== 'playing' || room.winnerId) return false;
  if (room.mode === 'battle') return reconcileBattle(room);
  if (room.mode === 'showdown') return reconcileShowdown(room);
  const target = modeFor(room).targetScore;
  if (!Number.isFinite(target)) return false;
  const eligible = room.players.filter(player => Number(player.score) >= target);
  if (!eligible.length) return false;
  const winner = preferredPlayer && eligible.some(player => player.id === preferredPlayer.id)
    ? preferredPlayer
    : [...eligible].sort((left, right) => right.score - left.score || left.joinedAt - right.joinedAt)[0];
  return finishMatch(room, winner, winner.id === preferredPlayer?.id ? banked : 0);
}

function addSpectator(room, name, profile = null) {
  const spectator = { id: crypto.randomUUID(), name, profileId: profile?.id || null, profile: profileSummary(profile), ...identitySecrets(), joinedAt: Date.now() };
  room.spectators.push(spectator);
  room.updatedAt = Date.now();
  return spectator;
}

function addPlayer(room, name, profile = null) {
  const player = {
    id: crypto.randomUUID(),
    name,
    score: 0,
    shieldAvailable: true,
    frozen: false,
    stats: { rolls: 0, busts: 0, bestBank: 0 },
    ready: false,
    career: { games: 0, wins: 0, totalBanked: 0 },
    matchBanked: 0,
    matchFreezes: 0,
    turnsTaken: 0,
    isBot: false,
    profileId: profile?.id || null,
    profile: profileSummary(profile),
    ...identitySecrets(),
    joinedAt: Date.now()
  };
  room.players.push(player);
  room.updatedAt = Date.now();
  return player;
}

function resetReadiness(room) {
  room.players.forEach(player => { player.ready = Boolean(player.isBot); });
}

function addBot(room, styleValue = 'balanced') {
  if (room.phase !== 'lobby') throw Object.assign(new Error('Practice players can only join in the lobby.'), { status: 409 });
  if (room.players.length >= MAX_PLAYERS) throw Object.assign(new Error('The player table is full.'), { status: 409 });
  const style = botStyle(styleValue);
  const bot = addPlayer(room, availableBotName(room.players));
  bot.isBot = true;
  bot.botStyle = style.id;
  bot.ready = true;
  room.message = `${bot.name} joined as a ${style.name.toLowerCase()} practice player`;
  addEvent(room, 'player_join', room.message, { actorId: bot.id, bot: true, style: style.id });
  return bot;
}

function createRoom(name, profile = null) {
  const code = roomCode();
  const room = {
    code,
    schemaVersion: 4,
    matchId: 0,
    matchStartedAt: null,
    matchArchived: true,
    hostId: null,
    players: [],
    departedPlayers: [],
    spectators: [],
    mode: 'classic',
    phase: 'lobby',
    turnIndex: 0,
    turnNumber: 0,
    turnScore: 0,
    rollStreak: 0,
    freezeUsed: false,
    paused: false,
    turnDurationMs: TURN_MS,
    turnDeadline: null,
    lastRoll: null,
    lastRollKind: 'normal',
    lastReward: null,
    lastOutcome: null,
    winnerId: null,
    showdownRoundLimit: 5,
    showdownSuddenDeath: false,
    showdownContenders: [],
    message: 'Waiting for players',
    chat: [],
    reactions: [],
    events: [],
    version: 1,
    updatedAt: Date.now()
  };
  const player = addPlayer(room, name, profile);
  room.hostId = player.id;
  player.ready = true;
  rooms.set(code, room);
  persistRooms();
  return { room, player };
}

function riskFor(room, extra = 0) {
  const mode = modeFor(room);
  return {
    percent: Math.min(75, mode.riskStart + (room.rollStreak || 0) * mode.riskStep + extra),
    penalty: 5
  };
}

function riskDieFor(room) {
  const rewardFaces = 5;
  const skullFaces = Math.min(8, 5 + Math.floor((room.rollStreak || 0) / 2));
  return {
    percent: Math.round((skullFaces / (rewardFaces + skullFaces)) * 100),
    skullFaces,
    rewardFaces,
    penalty: 5
  };
}

function riskDieOutcome(room, randomInt = crypto.randomInt) {
  const risk = riskDieFor(room);
  const busted = randomInt(risk.skullFaces + risk.rewardFaces) < risk.skullFaces;
  if (busted) return { busted: true, reward: 0, risk };
  const rewards = [10, 10, 20, 20, 30];
  return { busted: false, reward: rewards[randomInt(rewards.length)], risk };
}

function battleDieOutcome(room, type, randomInt = crypto.randomInt) {
  if (type === 'risk_die') {
    const result = riskDieOutcome(room, randomInt);
    return result.busted
      ? { dieKind: 'risk', busted: true, face: 'skull', damage: 0, selfDamage: 10, risk: result.risk }
      : { dieKind: 'risk', busted: false, face: `+${result.reward}`, damage: result.reward, selfDamage: 0, risk: result.risk };
  }
  const face = randomInt(1, 7);
  return face === 1
    ? { dieKind: 'normal', busted: true, face, damage: 0, selfDamage: 5 }
    : { dieKind: 'normal', busted: false, face, damage: face, selfDamage: 0 };
}

function standingOpponent(room, playerIndex) {
  for (let offset = 1; offset < room.players.length; offset += 1) {
    const candidate = room.players[(playerIndex + offset) % room.players.length];
    if (Number(candidate.score) > 0) return candidate;
  }
  return null;
}

function applySafeRoll(room, roll) {
  room.turnScore += roll;
  room.rollStreak += 1;
  const bonus = room.rollStreak % 3 === 0 ? 10 : 0;
  room.turnScore += bonus;
  return bonus;
}

function addChatMessage(room, playerId, value, now = Date.now()) {
  const player = [...room.players, ...(room.spectators || [])].find(candidate => candidate.id === playerId);
  if (!player) throw Object.assign(new Error('You are not in this room.'), { status: 403 });
  const text = cleanMessage(value);
  if (!text) throw Object.assign(new Error('Write a message first.'), { status: 400 });
  const previous = room.chat.at(-1);
  if (previous?.playerId === playerId && now - previous.at < 500) {
    throw Object.assign(new Error('Send messages a little slower.'), { status: 429 });
  }
  room.chat.push({ id: crypto.randomUUID(), playerId, name: player.name, text, at: now });
  room.chat = room.chat.slice(-50);
  bump(room);
  persistRooms();
}

function addReaction(room, playerId, emoji, now = Date.now()) {
  const allowed = new Set(['🔥', '😂', '😱', '🎉', '👏', '❄️']);
  const person = [...room.players, ...(room.spectators || [])].find(candidate => candidate.id === playerId);
  if (!person) throw Object.assign(new Error('You are not in this room.'), { status: 403 });
  if (!allowed.has(emoji)) throw Object.assign(new Error('That reaction is not available.'), { status: 400 });
  if (person.lastReactionAt && now - person.lastReactionAt < 700) {
    throw Object.assign(new Error('React a little slower.'), { status: 429 });
  }
  person.lastReactionAt = now;
  room.reactions.push({ id: crypto.randomUUID(), playerId, name: person.name, emoji, at: now });
  room.reactions = room.reactions.slice(-30);
  bump(room);
}

function awardsFor(room) {
  if (room.phase !== 'finished' || !room.players.length) return [];
  const by = selector => [...room.players].sort((a, b) => selector(b) - selector(a))[0];
  const biggest = by(player => player.stats?.bestBank || 0);
  const boldest = by(player => player.stats?.rolls || 0);
  const bravest = by(player => player.stats?.busts || 0);
  return [
    { title: 'Vault Master', playerId: biggest.id, value: `${biggest.stats?.bestBank || 0} biggest bank`, icon: '💰' },
    { title: 'Dice Addict', playerId: boldest.id, value: `${boldest.stats?.rolls || 0} rolls`, icon: '🎲' },
    (bravest.stats?.busts || 0) > 0 ? { title: 'Brave Soul', playerId: bravest.id, value: `${bravest.stats.busts} busts`, icon: '🔥' } : null
  ].filter(Boolean);
}

function publicState(room, playerId) {
  return {
    code: room.code,
    matchId: room.matchId || 0,
    phase: room.phase,
    hostId: room.hostId,
    meId: playerId,
    players: room.players.map(({ id, name, score, shieldAvailable, frozen, stats, ready, career, profile, turnsTaken, isBot, botStyle: style }) => ({
      id, name, score, shieldAvailable, frozen, stats, ready, career, profile: profileSummary(profile),
      turnsTaken: Number(turnsTaken || 0), isBot: Boolean(isBot), botStyle: isBot ? botStyle(style).id : null
    })),
    spectators: (room.spectators || []).map(({ id, name, profile }) => ({ id, name, profile: profileSummary(profile) })),
    meRole: room.players.some(player => player.id === playerId) ? 'player' : 'spectator',
    meRejoinCode: [...room.players, ...(room.spectators || [])].find(person => person.id === playerId)?.rejoinCode || null,
    mode: modeFor(room),
    turnIndex: room.turnIndex,
    turnScore: room.turnScore,
    rollStreak: room.rollStreak || 0,
    risk: riskFor(room),
    riskDieRisk: riskDieFor(room),
    freezeUsed: room.freezeUsed || false,
    paused: room.paused || false,
    turnDurationMs: room.turnDurationMs || TURN_MS,
    nextBonusIn: 3 - ((room.rollStreak || 0) % 3),
    turnDeadline: room.turnDeadline,
    serverNow: Date.now(),
    lastRoll: room.lastRoll,
    lastRollKind: room.lastRollKind || 'normal',
    lastReward: room.lastReward || null,
    lastOutcome: room.lastOutcome || null,
    gameSystem: room.mode === 'battle' ? 'battle' : 'royale',
    winnerId: room.winnerId,
    message: room.message,
    chat: (room.chat || []).map(({ id, playerId: senderId, name, text, at }) => ({ id, playerId: senderId, name, text, at })),
    reactions: (room.reactions || []).slice(-12),
    events: (room.events || []).slice(-50),
    awards: awardsFor(room),
    allReady: room.players.length >= 2 && room.players.every(player => player.ready),
    targetScore: modeFor(room).targetScore,
    showdown: room.mode === 'showdown' ? {
      round: Math.max(1, Math.min(room.showdownRoundLimit || 5, ...room.players.map(player => Number(player.turnsTaken || 0) + 1))),
      turnLimit: room.showdownRoundLimit || 5,
      suddenDeath: Boolean(room.showdownSuddenDeath)
    } : null,
    botStyles: Object.values(BOT_STYLES).map(({ id, name }) => ({ id, name })),
    schemaVersion: 4,
    appVersion: APP_VERSION,
    maxPlayers: MAX_PLAYERS,
    maxSpectators: MAX_SPECTATORS,
    version: room.version
  };
}

function bump(room) {
  room.version += 1;
  room.updatedAt = Date.now();
}

function secureEqual(expected, supplied) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(supplied || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function bearerToken(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

function requestClientIp(req) {
  const socketIp = String(req.socket.remoteAddress || 'unknown');
  const trustedLocalProxy = socketIp === '127.0.0.1' || socketIp === '::1' || socketIp === '::ffff:127.0.0.1';
  const cloudflareIp = String(req.headers['cf-connecting-ip'] || '').trim();
  return trustedLocalProxy && /^[0-9a-f:.]{3,45}$/i.test(cloudflareIp) ? cloudflareIp : socketIp;
}

function authAttemptKey(req, scope) {
  return `${scope}:${requestClientIp(req)}`;
}

function recentAuthAttempts(req, scope) {
  const now = Date.now();
  const key = authAttemptKey(req, scope);
  const recent = (authAttempts.get(key) || []).filter(at => now - at < 5 * 60 * 1000);
  if (recent.length) authAttempts.set(key, recent);
  else authAttempts.delete(key);
  return { key, recent, now };
}

function checkAuthThrottle(req, scope, limit = 8) {
  const { recent } = recentAuthAttempts(req, scope);
  if (recent.length >= limit) throw Object.assign(new Error('Too many login attempts. Wait five minutes.'), { status: 429 });
}

function recordAuthFailure(req, scope) {
  const { key, recent, now } = recentAuthAttempts(req, scope);
  recent.push(now);
  authAttempts.set(key, recent);
  if (authAttempts.size > 1000) {
    for (const [candidate, attempts] of authAttempts) {
      if (!attempts.some(at => now - at < 5 * 60 * 1000)) authAttempts.delete(candidate);
    }
  }
}

function throttleCreation(req) {
  checkAuthThrottle(req, 'profile-create', 30);
  recordAuthFailure(req, 'profile-create');
}

function clearAuthThrottle(req, scope) {
  authAttempts.delete(authAttemptKey(req, scope));
}

function requireMember(room, playerId, sessionToken) {
  const member = [...room.players, ...(room.spectators || [])].find(person => person.id === playerId);
  if (!member || !secureEqual(member.sessionToken, sessionToken)) {
    throw Object.assign(new Error('Your private room session is invalid. Rejoin with your name and key.'), { status: 401 });
  }
  return member;
}

function nextTurn(room, message) {
  const completed = room.players[room.turnIndex];
  if (completed) completed.turnsTaken = Number(completed.turnsTaken || 0) + 1;
  room.turnScore = 0;
  room.rollStreak = 0;
  room.freezeUsed = false;
  let showdownNote = '';
  const reconcileRound = () => {
    const previousLimit = room.showdownRoundLimit || 5;
    if (reconcileWinner(room)) return true;
    if ((room.showdownRoundLimit || 5) > previousLimit) showdownNote = ` • ${room.message}`;
    return false;
  };
  if (reconcileRound()) return;
  const skipped = [];
  let checked = 0;
  do {
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    checked += 1;
    const candidate = room.players[room.turnIndex];
    const activeContender = !room.showdownSuddenDeath
      || !room.showdownContenders?.length
      || room.showdownContenders.includes(candidate.id);
    const activeBattlePlayer = room.mode !== 'battle' || Number(candidate.score) > 0;
    if (!activeContender || !activeBattlePlayer) continue;
    if (candidate.frozen) {
      candidate.frozen = false;
      candidate.turnsTaken = Number(candidate.turnsTaken || 0) + 1;
      skipped.push(candidate.name);
      if (reconcileRound()) return;
    } else {
      break;
    }
  } while (checked < room.players.length * 2);
  room.turnNumber = Number(room.turnNumber || 0) + 1 + skipped.length;
  room.turnDeadline = Date.now() + (room.turnDurationMs || TURN_MS);
  const freezeNote = skipped.length ? ` • ❄ ${skipped.join(', ')} ${skipped.length === 1 ? 'loses' : 'lose'} a turn` : '';
  room.message = (message || `${room.players[room.turnIndex].name}'s turn`) + freezeNote + showdownNote;
}

function expireTurnIfNeeded(room, now = Date.now()) {
  if (room.phase !== 'playing' || room.paused || !room.turnDeadline || room.turnDeadline > now) return false;
  const player = room.players[room.turnIndex];
  const message = `${player.name} ran out of time — turn pot lost!`;
  addEvent(room, 'timeout', message, { actorId: player.id });
  nextTurn(room, message);
  bump(room);
  persistRooms();
  if (room.phase === 'finished' && !room.matchArchived) {
    archiveCompletedMatch(room).catch(error => console.error('Could not record completed match:', error.message));
  }
  return true;
}

function processBotTurn(room, now = Date.now(), random = Math.random) {
  if (room.phase !== 'playing' || room.paused || !room.players.length) {
    botPlans.delete(room.code);
    return false;
  }
  const bot = room.players[room.turnIndex];
  if (!bot?.isBot) {
    botPlans.delete(room.code);
    return false;
  }
  const signature = `${room.matchId}:${room.turnNumber || 0}:${bot.id}`;
  let plan = botPlans.get(room.code);
  if (!plan || plan.signature !== signature) {
    plan = { signature, dueAt: now + 650 + Math.floor(random() * 751) };
    botPlans.set(room.code, plan);
    return false;
  }
  if (now < plan.dueAt) return false;

  const botRoom = {
    ...room,
    targetScore: modeFor(room).targetScore,
    riskPercent: riskFor(room).percent
  };
  const decision = chooseBotAction(botRoom, bot, random);
  try {
    action(room, bot.id, decision.type, decision.targetId);
  } catch (error) {
    console.error(`Practice player ${bot.name} could not act:`, error.message);
    botPlans.delete(room.code);
    return false;
  }
  const current = room.players[room.turnIndex];
  if (room.phase === 'playing' && current?.id === bot.id) {
    botPlans.set(room.code, {
      signature: `${room.matchId}:${room.turnNumber || 0}:${bot.id}`,
      dueAt: now + 650 + Math.floor(random() * 751)
    });
  } else {
    botPlans.delete(room.code);
  }
  return true;
}

function action(room, playerId, type, targetId, randomInt = crypto.randomInt) {
  const playerIndex = room.players.findIndex(player => player.id === playerId);
  if (playerIndex < 0) throw Object.assign(new Error('You are not in this room.'), { status: 403 });

  expireTurnIfNeeded(room);

  if (type === 'ready') {
    if (room.phase !== 'lobby') throw Object.assign(new Error('Ready checks only happen in the lobby.'), { status: 409 });
    const player = room.players[playerIndex];
    player.ready = !player.ready;
    room.message = `${player.name} is ${player.ready ? 'ready' : 'not ready'}`;
    addEvent(room, 'ready', room.message, { actorId: player.id, ready: player.ready });
    bump(room);
    persistRooms();
    return;
  }

  if (type === 'add_bot') {
    if (playerId !== room.hostId) throw Object.assign(new Error('Only the host can add a practice player.'), { status: 403 });
    addBot(room, targetId);
    bump(room);
    persistRooms();
    return;
  }

  if (type === 'remove_bot') {
    if (playerId !== room.hostId) throw Object.assign(new Error('Only the host can remove a practice player.'), { status: 403 });
    if (room.phase !== 'lobby') throw Object.assign(new Error('Practice players can only leave in the lobby.'), { status: 409 });
    const index = room.players.findIndex(candidate => candidate.id === targetId && candidate.isBot);
    if (index < 0) throw Object.assign(new Error('Practice player not found.'), { status: 404 });
    const [removed] = room.players.splice(index, 1);
    room.message = `${removed.name} left the practice table`;
    addEvent(room, 'player_leave', room.message, { actorId: removed.id, bot: true });
    bump(room);
    persistRooms();
    return;
  }

  if (type === 'set_mode') {
    if (playerId !== room.hostId) throw Object.assign(new Error('Only FALCON can choose the mode.'), { status: 403 });
    if (room.phase !== 'lobby') throw Object.assign(new Error('Choose a mode before the match starts.'), { status: 409 });
    if (!MODES[targetId]) throw Object.assign(new Error('Unknown game mode.'), { status: 400 });
    room.mode = targetId;
    room.turnDurationMs = MODES[targetId].turnMs;
    resetReadiness(room);
    room.message = `FALCON selected ${MODES[targetId].name} mode`;
    addEvent(room, 'mode', room.message, { actorId: playerId, mode: targetId });
    bump(room);
    persistRooms();
    return;
  }

  if (type === 'start') {
    if (playerId !== room.hostId) throw Object.assign(new Error('Only the host can start.'), { status: 403 });
    if (room.phase !== 'lobby') throw Object.assign(new Error('The game has already started.'), { status: 409 });
    if (room.players.length < 2) throw Object.assign(new Error('Invite at least one more player.'), { status: 409 });
    if (!room.players.every(player => player.ready)) throw Object.assign(new Error('Every player must be ready.'), { status: 409 });
    room.phase = 'playing';
    room.matchId = (room.matchId || 0) + 1;
    room.matchStartedAt = Date.now();
    room.matchArchived = false;
    room.events = [];
    room.players.forEach(candidate => {
      if (room.mode === 'battle') {
        candidate.score = 30;
        candidate.shieldAvailable = false;
      }
      candidate.matchBanked = 0;
      candidate.matchFreezes = 0;
      candidate.turnsTaken = 0;
    });
    room.departedPlayers = [];
    room.lastOutcome = null;
    room.showdownRoundLimit = 5;
    room.showdownSuddenDeath = false;
    room.showdownContenders = [];
    room.turnIndex = Math.floor(Math.random() * room.players.length);
    room.turnNumber = 1;
    room.turnDeadline = Date.now() + (room.turnDurationMs || TURN_MS);
    room.message = `${room.players[room.turnIndex].name} goes first`;
    addEvent(room, 'start', room.message, { matchId: room.matchId, mode: room.mode });
    bump(room);
    persistRooms();
    return;
  }

  if (type === 'restart') {
    if (playerId !== room.hostId) throw Object.assign(new Error('Only the host can start a rematch.'), { status: 403 });
    if (room.phase !== 'finished') throw Object.assign(new Error('This game is not finished.'), { status: 409 });
    room.players.forEach(player => {
      player.score = 0;
      player.shieldAvailable = true;
      player.frozen = false;
      player.stats = { rolls: 0, busts: 0, bestBank: 0 };
      player.matchBanked = 0;
      player.matchFreezes = 0;
      player.ready = Boolean(player.isBot);
      player.turnsTaken = 0;
    });
    room.phase = 'lobby';
    room.turnIndex = 0;
    room.turnNumber = 0;
    room.turnScore = 0;
    room.rollStreak = 0;
    room.freezeUsed = false;
    room.turnDeadline = null;
    room.lastRoll = null;
    room.lastRollKind = 'normal';
    room.lastReward = null;
    room.lastOutcome = null;
    room.winnerId = null;
    room.showdownRoundLimit = 5;
    room.showdownSuddenDeath = false;
    room.showdownContenders = [];
    room.departedPlayers = [];
    room.message = 'New round ready — everyone tap Ready';
    room.events = [];
    addEvent(room, 'lobby', room.message, { matchId: room.matchId });
    bump(room);
    persistRooms();
    return;
  }

  if (room.phase !== 'playing') throw Object.assign(new Error('The game is not active.'), { status: 409 });
  if (room.paused) throw Object.assign(new Error('FALCON paused this room.'), { status: 409 });
  if (playerIndex !== room.turnIndex) throw Object.assign(new Error('Wait for your turn.'), { status: 409 });

  const player = room.players[playerIndex];
  if (room.mode === 'battle' && player.score <= 0) {
    throw Object.assign(new Error('You are knocked out of this Battle Dice match.'), { status: 409 });
  }
  if (type === 'freeze') {
    const target = room.players.find(candidate => candidate.id === targetId);
    if (!target || target.id === playerId) throw Object.assign(new Error('Choose another player to freeze.'), { status: 400 });
    if (room.mode === 'battle' && target.score <= 0) throw Object.assign(new Error('Choose a player who is still standing.'), { status: 400 });
    if (player.score < 5 || (room.mode === 'battle' && player.score === 5)) throw Object.assign(new Error(room.mode === 'battle' ? 'You need more than 5 health to freeze someone.' : 'You need 5 banked points to freeze someone.'), { status: 409 });
    if (room.freezeUsed) throw Object.assign(new Error('You already used Freeze this turn.'), { status: 409 });
    if (target.frozen) throw Object.assign(new Error(`${target.name} is already frozen.`), { status: 409 });
    player.score -= 5;
    player.matchFreezes = (player.matchFreezes || 0) + 1;
    target.frozen = true;
    room.freezeUsed = true;
    room.turnDeadline = Date.now() + (room.turnDurationMs || TURN_MS);
    room.message = `${player.name} spent 5 points to freeze ${target.name}'s next turn!`;
    addEvent(room, 'freeze', room.message, { actorId: player.id, targetId: target.id, amount: 5 });
    bump(room);
    persistRooms();
    return;
  }

  if (room.mode === 'battle' && (type === 'roll' || type === 'risk_die')) {
    const target = standingOpponent(room, playerIndex);
    if (!target) {
      reconcileWinner(room);
      return;
    }
    const outcome = battleDieOutcome(room, type, randomInt);
    player.stats ??= { rolls: 0, busts: 0, bestBank: 0 };
    player.career ??= { games: 0, wins: 0, totalBanked: 0 };
    player.stats.rolls += 1;
    room.lastRollKind = outcome.dieKind;
    room.lastRoll = outcome.busted ? 1 : outcome.face;
    room.lastReward = outcome.busted ? null : outcome.damage;
    if (outcome.busted) {
      player.stats.busts += 1;
      player.score -= outcome.selfDamage;
      room.message = outcome.dieKind === 'risk'
        ? `${player.name} rolled a SKULL and lost ${outcome.selfDamage} health!`
        : `${player.name} rolled 1 and lost ${outcome.selfDamage} health!`;
    } else {
      target.score -= outcome.damage;
      player.matchBanked = (player.matchBanked || 0) + outcome.damage;
      player.career.totalBanked += outcome.damage;
      player.stats.bestBank = Math.max(player.stats.bestBank, outcome.damage);
      room.message = `${player.name} hit ${target.name} for ${outcome.damage} damage with the ${outcome.dieKind === 'risk' ? 'Deadly Risk Die' : 'Normal Die'}!`;
    }
    room.lastOutcome = { ...outcome, actorId: player.id, targetId: outcome.busted ? null : target.id };
    addEvent(room, outcome.busted ? 'battle_bust' : 'battle_hit', room.message, room.lastOutcome);
    if (!reconcileWinner(room)) nextTurn(room, room.message);
    bump(room);
    persistRooms();
    if (room.phase === 'finished' && !room.matchArchived) archiveCompletedMatch(room).catch(error => console.error('Could not record completed match:', error.message));
    return;
  }

  if (type === 'roll' || type === 'risk_die') {
    const risky = type === 'risk_die';
    const riskOutcome = risky ? riskDieOutcome(room) : null;
    const risk = riskOutcome?.risk || riskFor(room);
    const busted = risky ? riskOutcome.busted : crypto.randomInt(100) < risk.percent;
    const roll = busted ? 1 : risky ? riskOutcome.reward : crypto.randomInt(2, 7);
    room.lastRoll = busted ? 1 : risky ? 6 : roll;
    room.lastRollKind = risky ? 'risk' : 'normal';
    room.lastReward = risky && !busted ? roll : null;
    player.stats ??= { rolls: 0, busts: 0, bestBank: 0 };
    player.stats.rolls += 1;
    if (busted) {
      player.stats.busts += 1;
      const shielded = player.shieldAvailable;
      let message;
      if (shielded) {
        player.shieldAvailable = false;
        message = `${player.name} BUSTED — Safety Net blocked the −${risk.penalty} penalty!`;
      } else {
        player.score -= risk.penalty;
        message = `${player.name} BUSTED — pot lost and −${risk.penalty} points!`;
      }
      room.lastOutcome = { dieKind: risky ? 'risk' : 'normal', busted: true, face: risky ? 'skull' : 1, reward: 0, penalty: shielded ? 0 : risk.penalty, shielded };
      addEvent(room, 'bust', message, { actorId: player.id, die: 1, penalty: shielded ? 0 : risk.penalty, risky });
      nextTurn(room, message);
    } else {
      const points = roll;
      const bonus = applySafeRoll(room, points);
      room.lastOutcome = { dieKind: risky ? 'risk' : 'normal', busted: false, face: risky ? `+${points}` : roll, reward: points, bonus };
      room.turnDeadline = Date.now() + (room.turnDurationMs || TURN_MS);
      room.message = risky
        ? `${player.name} hit the Risk Die for ${points} points!${bonus ? ' + 10 HOT STREAK!' : ''}`
        : bonus
        ? `${player.name} hit a HOT STREAK — ${roll} + 10 bonus!`
        : `${player.name} rolled ${roll} — risk is climbing`;
      addEvent(room, risky ? 'risk_die' : bonus ? 'hot_streak' : 'roll', room.message, { actorId: player.id, die: roll, points, bonus, risky });
    }
    bump(room);
    persistRooms();
    if (room.phase === 'finished' && !room.matchArchived) {
      archiveCompletedMatch(room).catch(error => console.error('Could not record completed match:', error.message));
    }
    return;
  }

  if (type === 'hold') {
    if (room.mode === 'battle') throw Object.assign(new Error('Battle Dice turns end after one attack roll.'), { status: 409 });
    if (room.turnScore < 1) throw Object.assign(new Error('Roll before you hold.'), { status: 409 });
    player.score += room.turnScore;
    const banked = room.turnScore;
    player.stats ??= { rolls: 0, busts: 0, bestBank: 0 };
    player.stats.bestBank = Math.max(player.stats.bestBank, banked);
    player.career ??= { games: 0, wins: 0, totalBanked: 0 };
    player.career.totalBanked += banked;
    player.matchBanked = (player.matchBanked || 0) + banked;
    if (!reconcileWinner(room, player, banked)) {
      nextTurn(room, `${player.name} banked ${banked} points`);
      if (room.phase === 'playing') addEvent(room, 'bank', room.message, { actorId: player.id, amount: banked, score: player.score });
    }
    bump(room);
    persistRooms();
    if (room.phase === 'finished') {
      archiveCompletedMatch(room).catch(error => {
        console.error('Could not record completed match:', error.message);
      });
    }
    return;
  }

  throw Object.assign(new Error('Unknown action.'), { status: 400 });
}

function resetMatch(room) {
  room.players.forEach(player => {
    player.score = 0;
    player.shieldAvailable = true;
    player.frozen = false;
    player.stats = { rolls: 0, busts: 0, bestBank: 0 };
    player.matchBanked = 0;
    player.matchFreezes = 0;
    player.ready = Boolean(player.isBot);
    player.turnsTaken = 0;
  });
  room.phase = 'lobby';
  room.paused = false;
  room.turnIndex = 0;
  room.turnNumber = 0;
  room.turnScore = 0;
  room.rollStreak = 0;
  room.freezeUsed = false;
  room.turnDeadline = null;
  room.lastRoll = null;
  room.lastRollKind = 'normal';
  room.lastReward = null;
  room.lastOutcome = null;
  room.winnerId = null;
  room.showdownRoundLimit = 5;
  room.showdownSuddenDeath = false;
  room.showdownContenders = [];
  room.departedPlayers = [];
  room.message = 'Match reset by FALCON — ready when you are';
  room.events = [];
}

function adminRoomState(room) {
  return {
    ...publicState(room, room.hostId),
    updatedAt: room.updatedAt,
    players: room.players.map(player => ({
      id: player.id,
      name: player.id === room.hostId ? 'FALCON' : player.name,
      score: player.score,
      frozen: player.frozen,
      shieldAvailable: player.shieldAvailable,
      stats: player.stats,
      ready: player.ready,
      career: player.career,
      profile: player.profile,
      turnsTaken: Number(player.turnsTaken || 0),
      isBot: Boolean(player.isBot),
      botStyle: player.isBot ? botStyle(player.botStyle).id : null
    })),
    spectators: (room.spectators || []).map(({ id, name, profile }) => ({ id, name, profile }))
  };
}

function adminAction(room, type, payload = {}) {
  if (type === 'pause') {
    if (room.phase !== 'playing' || room.paused) throw Object.assign(new Error('Room cannot be paused right now.'), { status: 409 });
    room.pauseRemaining = Math.max(0, (room.turnDeadline || Date.now()) - Date.now());
    room.paused = true;
    room.turnDeadline = null;
    room.message = '⏸ FALCON paused the table';
  } else if (type === 'resume') {
    if (room.phase !== 'playing' || !room.paused) throw Object.assign(new Error('Room is not paused.'), { status: 409 });
    room.paused = false;
    room.turnDeadline = Date.now() + Math.max(2_000, room.pauseRemaining || room.turnDurationMs);
    room.pauseRemaining = null;
    room.message = '▶ FALCON resumed the table';
  } else if (type === 'set_timer') {
    const seconds = Math.round(Number(payload.seconds));
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 60) throw Object.assign(new Error('Timer must be between 5 and 60 seconds.'), { status: 400 });
    room.turnDurationMs = seconds * 1000;
    if (room.paused) room.pauseRemaining = room.turnDurationMs;
    if (room.phase === 'playing' && !room.paused) room.turnDeadline = Date.now() + room.turnDurationMs;
    room.message = `⏱ FALCON set turns to ${seconds} seconds`;
  } else if (type === 'set_mode') {
    if (room.phase !== 'lobby') throw Object.assign(new Error('Mode can only change in the lobby.'), { status: 409 });
    if (!MODES[payload.mode]) throw Object.assign(new Error('Unknown game mode.'), { status: 400 });
    room.mode = payload.mode;
    room.turnDurationMs = MODES[payload.mode].turnMs;
    resetReadiness(room);
    room.message = `FALCON selected ${MODES[payload.mode].name} mode`;
  } else if (type === 'add_bot') {
    addBot(room, payload.style || 'balanced');
  } else if (type === 'remove_bot') {
    if (room.phase !== 'lobby') throw Object.assign(new Error('Practice players can only leave in the lobby.'), { status: 409 });
    const index = room.players.findIndex(candidate => candidate.id === payload.playerId && candidate.isBot);
    if (index < 0) throw Object.assign(new Error('Practice player not found.'), { status: 404 });
    const [removed] = room.players.splice(index, 1);
    room.message = `${removed.name} left the practice table`;
    addEvent(room, 'player_leave', room.message, { actorId: removed.id, bot: true });
  } else if (type === 'score') {
    const player = room.players.find(candidate => candidate.id === payload.playerId);
    const delta = Math.round(Number(payload.delta));
    if (!player || !Number.isFinite(delta) || delta < -100 || delta > 100) throw Object.assign(new Error('Invalid score adjustment.'), { status: 400 });
    player.score += delta;
    if (!reconcileWinner(room, player)) {
      room.message = `FALCON ${delta >= 0 ? 'added' : 'removed'} ${Math.abs(delta)} points ${delta >= 0 ? 'to' : 'from'} ${player.id === room.hostId ? 'FALCON' : player.name}`;
      if (room.mode === 'battle' && room.players[room.turnIndex]?.score <= 0) {
        nextTurn(room, `${room.players[room.turnIndex].name} was knocked out by FALCON`);
      }
    }
  } else if (type === 'remove_player') {
    const index = room.players.findIndex(candidate => candidate.id === payload.playerId);
    if (index < 0) throw Object.assign(new Error('Player not found.'), { status: 404 });
    if (room.players[index].id === room.hostId) throw Object.assign(new Error('FALCON cannot remove the admin.'), { status: 409 });
    const [removed] = room.players.splice(index, 1);
    if (room.phase === 'playing') {
      room.departedPlayers ??= [];
      room.departedPlayers.push(JSON.parse(JSON.stringify(removed)));
    }
    if (room.showdownSuddenDeath) room.showdownContenders = (room.showdownContenders || []).filter(id => id !== removed.id);
    if (index < room.turnIndex) room.turnIndex -= 1;
    else if (index === room.turnIndex) {
      room.turnIndex %= Math.max(1, room.players.length);
      room.turnScore = 0;
      room.rollStreak = 0;
      room.freezeUsed = false;
      room.turnDeadline = Date.now() + room.turnDurationMs;
    }
    const battleResolved = room.phase === 'playing' && room.mode === 'battle' && reconcileWinner(room);
    if (!battleResolved && (removed.id === room.winnerId || (room.players.length < 2 && room.phase === 'playing'))) {
      resetMatch(room);
    } else if (!battleResolved && room.phase === 'playing' && room.mode === 'showdown' && room.showdownSuddenDeath && room.showdownContenders.length === 1) {
      const remaining = room.players.find(player => player.id === room.showdownContenders[0]);
      if (remaining) finishMatch(room, remaining);
    }
    if (room.phase !== 'finished') room.message = `${removed.name} was removed by FALCON`;
  } else if (type === 'remove_spectator') {
    const index = (room.spectators || []).findIndex(candidate => candidate.id === payload.playerId);
    if (index < 0) throw Object.assign(new Error('Spectator not found.'), { status: 404 });
    const [removed] = room.spectators.splice(index, 1);
    room.message = `${removed.name} left the gallery`;
  } else if (type === 'announce') {
    const text = cleanMessage(payload.text).slice(0, 120);
    if (!text) throw Object.assign(new Error('Write an announcement first.'), { status: 400 });
    room.message = `📣 FALCON: ${text}`;
    room.chat.push({ id: crypto.randomUUID(), playerId: 'admin', name: 'FALCON · ADMIN', text, at: Date.now() });
    room.chat = room.chat.slice(-50);
  } else if (type === 'clear_chat') {
    room.chat = [];
    room.message = 'FALCON cleared the room chat';
  } else if (type === 'reset') {
    resetMatch(room);
  } else if (type === 'start' || type === 'force_start') {
    if (type === 'force_start') room.players.forEach(player => { player.ready = true; });
    action(room, room.hostId, 'start');
    return;
  } else {
    throw Object.assign(new Error('Unknown admin action.'), { status: 400 });
  }
  addEvent(room, 'admin', room.message, { action: type });
  bump(room);
  persistRooms();
  if (room.phase === 'finished' && !room.matchArchived) {
    archiveCompletedMatch(room).catch(error => console.error('Could not record completed match:', error.message));
  }
}

function isAdminRequest(req) {
  const supplied = bearerToken(req);
  const expected = Buffer.from(ADMIN_TOKEN);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw Object.assign(new Error('Request too large.'), { status: 413 });
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
  }
}

function serveStatic(req, res) {
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  const requested = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const filePath = path.resolve(publicDir, requested);
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== path.join(publicDir, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404).end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
    res.writeHead(200, {
      'Content-Type': `${types[ext] || 'application/octet-stream'}; charset=utf-8`,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, rooms: rooms.size, storage: 'json', version: APP_VERSION });
    }

    if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
      return sendJson(res, 200, { version: APP_VERSION, leaderboard: await profiles.leaderboard(url.searchParams.get('limit'), url.searchParams.get('sort')) });
    }

    if (parts[0] === 'api' && parts[1] === 'profiles') {
      if (req.method === 'POST' && parts.length === 2) {
        throttleCreation(req);
        const { displayName, pin } = await readJson(req);
        return sendJson(res, 201, await profiles.create(displayName, pin));
      }
      if (req.method === 'POST' && parts[2] === 'login' && parts.length === 3) {
        const { code, pin } = await readJson(req);
        const scope = `profile-login:${normalizeCode(code)}`;
        checkAuthThrottle(req, scope);
        try {
          const login = await profiles.login(code, pin);
          clearAuthThrottle(req, scope);
          return sendJson(res, 200, login);
        } catch (error) {
          if (error.status === 401) recordAuthFailure(req, scope);
          throw error;
        }
      }
      if (req.method === 'GET' && parts[2] === 'me' && parts.length === 3) {
        const profile = await profiles.authenticate(bearerToken(req));
        if (!profile) return sendJson(res, 401, { error: 'Sign in to a profile first.' });
        return sendJson(res, 200, { profile });
      }
      return sendJson(res, 404, { error: 'Profile route not found.' });
    }

    if (parts[0] === 'api' && parts[1] === 'admin') {
      if (!ADMIN_ENABLED) return sendJson(res, 404, { error: 'Not found.' });
      if (!isAdminRequest(req)) {
        checkAuthThrottle(req, 'admin');
        recordAuthFailure(req, 'admin');
        return sendJson(res, 401, { error: 'Invalid admin key.' });
      }
      clearAuthThrottle(req, 'admin');
      if (req.method === 'GET' && parts[2] === 'records' && parts.length === 3) {
        return sendJson(res, 200, await recordsStore.records(url.searchParams.get('limit')));
      }
      if (req.method === 'GET' && parts[2] === 'rooms' && parts.length === 3) {
        return sendJson(res, 200, { rooms: [...rooms.values()].map(adminRoomState) });
      }
      if (req.method === 'POST' && parts[2] === 'leaderboard' && parts[3] === 'reset') {
        const result = await profiles.resetLeaderboard();
        await recordsStore.reset();
        return sendJson(res, 200, { reset: true, ...result });
      }
      if (req.method === 'POST' && parts[2] === 'rooms' && parts[3]) {
        const code = parts[3].toUpperCase();
        const room = rooms.get(code);
        if (!room) return sendJson(res, 404, { error: 'Room not found.' });
        const payload = await readJson(req);
        if (payload.type === 'close') {
          botPlans.delete(code);
          rooms.delete(code);
          retiredRooms.add(code);
          persistRooms();
          persistRetiredRooms();
          return sendJson(res, 200, { closed: true, code });
        }
        adminAction(room, payload.type, payload);
        if (room.phase === 'finished' && !room.matchArchived) await archiveCompletedMatch(room);
        return sendJson(res, 200, { room: adminRoomState(room) });
      }
      return sendJson(res, 404, { error: 'Admin route not found.' });
    }

    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const { name, profileToken } = await readJson(req);
      const profile = await profiles.authenticate(profileToken);
      const cleaned = cleanName(profile?.displayName || name);
      if (!cleaned) return sendJson(res, 400, { error: 'Enter your name.' });
      const { room, player } = createRoom(cleaned, profile);
      return sendJson(res, 201, { playerId: player.id, sessionToken: player.sessionToken, rejoinCode: player.rejoinCode, room: publicState(room, player.id) });
    }

    if (parts[0] === 'api' && parts[1] === 'rooms' && parts[2]) {
      const code = parts[2].toUpperCase();
      const room = rooms.get(code);
      const restoring = req.method === 'POST' && parts[3] === 'restore';
      if (restoring && retiredRooms.has(code)) return sendJson(res, 410, { error: 'This room was cleared. Create a new room.' });
      if (!room && !restoring) return sendJson(res, 404, { error: 'Room not found. Check the code.' });

      if (req.method === 'POST' && parts[3] === 'join') {
        const { name, role, rejoinCode, profileToken } = await readJson(req);
        const profile = await profiles.authenticate(profileToken);
        const cleaned = cleanName(profile?.displayName || name);
        if (!cleaned) return sendJson(res, 400, { error: 'Enter your name.' });
        const everyone = [...room.players, ...(room.spectators || [])];
        const returning = everyone.find(person => person.name.toLowerCase() === cleaned.toLowerCase());
        if (returning) {
          const rejoinScope = `room-rejoin:${code}:${cleaned.toLowerCase()}`;
          const profileOwnsSeat = profile && returning.profileId === profile.id;
          if (!profileOwnsSeat && !secureEqual(returning.rejoinCode, rejoinCode)) {
            checkAuthThrottle(req, rejoinScope);
            recordAuthFailure(req, rejoinScope);
            return sendJson(res, 401, { error: 'That name is saved. Enter its private 6-digit rejoin key.' });
          }
          clearAuthThrottle(req, rejoinScope);
          returning.sessionToken = crypto.randomBytes(24).toString('base64url');
          if (profileOwnsSeat) returning.profile = profileSummary(profile);
          const spectatorIndex = (room.spectators || []).findIndex(person => person.id === returning.id);
          if (role === 'player' && room.phase === 'lobby' && spectatorIndex >= 0) {
            if (room.players.length >= MAX_PLAYERS) return sendJson(res, 409, { error: 'The player table is full.' });
            room.spectators.splice(spectatorIndex, 1);
            Object.assign(returning, { score: 0, shieldAvailable: true, frozen: false, stats: { rolls: 0, busts: 0, bestBank: 0 }, ready: false, career: returning.career || { games: 0, wins: 0, totalBanked: 0 } });
            room.players.push(returning);
            resetReadiness(room);
            room.message = `${returning.name} moved from the gallery to the table`;
            addEvent(room, 'player_join', room.message, { actorId: returning.id, promoted: true });
          } else {
            room.message = `${returning.id === room.hostId ? 'FALCON' : returning.name} rejoined the room`;
          }
          bump(room);
          persistRooms();
          return sendJson(res, 200, { playerId: returning.id, sessionToken: returning.sessionToken, rejoinCode: returning.rejoinCode, rejoined: true, room: publicState(room, returning.id) });
        }
        if (cleaned.toLowerCase() === 'falcon') return sendJson(res, 409, { error: 'FALCON is reserved for the room host.' });
        const asSpectator = role === 'spectator' || room.phase !== 'lobby';
        if (asSpectator) {
          if ((room.spectators || []).length >= MAX_SPECTATORS) return sendJson(res, 409, { error: 'The spectator gallery is full.' });
          const spectator = addSpectator(room, cleaned, profile);
          room.message = `${cleaned} joined the gallery`;
          addEvent(room, 'spectator_join', room.message, { actorId: spectator.id });
          bump(room);
          persistRooms();
          return sendJson(res, 200, { playerId: spectator.id, sessionToken: spectator.sessionToken, rejoinCode: spectator.rejoinCode, room: publicState(room, spectator.id) });
        }
        if (room.players.length >= MAX_PLAYERS) return sendJson(res, 409, { error: 'The player table is full. Join as a spectator.' });
        if (profile && room.players.some(candidate => candidate.profileId === profile.id)) {
          return sendJson(res, 409, { error: 'This profile already has a seat in the room.' });
        }
        const player = addPlayer(room, cleaned, profile);
        resetReadiness(room);
        room.message = `${cleaned} joined the table`;
        addEvent(room, 'player_join', room.message, { actorId: player.id });
        bump(room);
        persistRooms();
        return sendJson(res, 200, { playerId: player.id, sessionToken: player.sessionToken, rejoinCode: player.rejoinCode, room: publicState(room, player.id) });
      }

      if (req.method === 'POST' && parts[3] === 'restore') {
        return sendJson(res, 410, { error: 'Old browser snapshots are retired. This room is saved safely on the server.' });
        /* Legacy snapshot parser kept below for one release as migration reference. */
        const { playerId, snapshot } = await readJson(req);
        if (rooms.has(code)) return sendJson(res, 409, { error: 'Room is already active.' });
        const validPhases = new Set(['lobby', 'playing', 'finished']);
        const players = snapshot?.players;
        const valid = snapshot?.code === code && validPhases.has(snapshot?.phase)
          && Array.isArray(players) && players.length >= 1 && players.length <= MAX_PLAYERS
          && players.some(player => player.id === playerId)
          && players.every(player => typeof player.id === 'string' && cleanName(player.name) && Number.isFinite(player.score));
        if (!valid) return sendJson(res, 400, { error: 'Saved room data is invalid.' });
        const restored = {
          code,
          hostId: snapshot.hostId,
          players: players.map(player => ({
            id: player.id,
            name: cleanName(player.name),
            score: player.score,
            shieldAvailable: player.shieldAvailable !== false,
            frozen: Boolean(player.frozen),
            stats: {
              rolls: Number.isFinite(player.stats?.rolls) ? player.stats.rolls : 0,
              busts: Number.isFinite(player.stats?.busts) ? player.stats.busts : 0,
              bestBank: Number.isFinite(player.stats?.bestBank) ? player.stats.bestBank : 0
            },
            joinedAt: Date.now()
          })),
          phase: snapshot.phase,
          turnIndex: Math.min(Math.max(0, snapshot.turnIndex || 0), players.length - 1),
          turnScore: Number.isFinite(snapshot.turnScore) ? snapshot.turnScore : 0,
          rollStreak: Number.isFinite(snapshot.rollStreak) ? snapshot.rollStreak : 0,
          freezeUsed: Boolean(snapshot.freezeUsed),
          turnDeadline: snapshot.phase === 'playing' ? Date.now() + (Number.isFinite(snapshot.turnDurationMs) ? snapshot.turnDurationMs : TURN_MS) : null,
          paused: false,
          turnDurationMs: Number.isFinite(snapshot.turnDurationMs) ? Math.min(60_000, Math.max(5_000, snapshot.turnDurationMs)) : TURN_MS,
          lastRoll: snapshot.lastRoll || null,
          winnerId: snapshot.winnerId || null,
          message: snapshot.message || 'Game restored',
          chat: Array.isArray(snapshot.chat) ? snapshot.chat.slice(-50).map(item => ({
            id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
            playerId: String(item.playerId || ''),
            name: cleanName(item.name),
            text: cleanMessage(item.text),
            at: Number.isFinite(item.at) ? item.at : Date.now()
          })).filter(item => item.text) : [],
          version: (snapshot.version || 0) + 1,
          updatedAt: Date.now()
        };
        rooms.set(code, restored);
        persistRooms();
        return sendJson(res, 201, { room: publicState(restored, playerId) });
      }

      if (req.method === 'GET' && parts.length === 3) {
        const playerId = url.searchParams.get('playerId');
        const sessionToken = bearerToken(req);
        requireMember(room, playerId, sessionToken);
        return sendJson(res, 200, { room: publicState(room, playerId) });
      }

      if (req.method === 'POST' && parts[3] === 'action') {
        const { playerId, sessionToken, type, targetId } = await readJson(req);
        requireMember(room, playerId, sessionToken);
        action(room, playerId, type, targetId);
        return sendJson(res, 200, { room: publicState(room, playerId) });
      }

      if (req.method === 'POST' && parts[3] === 'chat') {
        const { playerId, sessionToken, text } = await readJson(req);
        requireMember(room, playerId, sessionToken);
        addChatMessage(room, playerId, text);
        return sendJson(res, 200, { room: publicState(room, playerId) });
      }

      if (req.method === 'POST' && parts[3] === 'reaction') {
        const { playerId, sessionToken, emoji } = await readJson(req);
        requireMember(room, playerId, sessionToken);
        addReaction(room, playerId, emoji);
        return sendJson(res, 200, { room: publicState(room, playerId) });
      }
    }

    if (req.method === 'GET') return serveStatic(req, res);
    sendJson(res, 404, { error: 'Not found.' });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.status ? error.message : 'Server error.' });
  }
});

const cleanup = setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  let changed = false;
  for (const [code, room] of rooms) {
    if (room.updatedAt < cutoff) {
      botPlans.delete(code);
      rooms.delete(code);
      changed = true;
    }
  }
  if (changed) {
    try { persistRooms(); }
    catch (error) { console.error('Could not save expired-room cleanup:', error.message); }
  }
}, 30 * 60 * 1000);
cleanup.unref();

const turnClock = setInterval(() => {
  for (const room of rooms.values()) {
    try {
      expireTurnIfNeeded(room);
      processBotTurn(room);
    } catch (error) {
      console.error(`Could not process room ${room.code}:`, error.message);
    }
  }
}, 250);
turnClock.unref();

async function startServer() {
  await initializeStorage();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => {
      server.off('error', reject);
      console.log(`Dice Night is live at http://${HOST}:${PORT}`);
      resolve();
    });
  });
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('Dice Night could not start:', error.message);
    process.exitCode = 1;
  });

  const shutdown = signal => {
    console.log(`${signal} received, saving game state...`);
    persistRooms();
    server.close(async () => {
      await recordsStore.close();
      process.exit(0);
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  server, startServer, recordsStore, profiles, rooms, retiredRooms, createRoom, action, adminAction,
  publicState, riskFor, riskDieFor, riskDieOutcome, battleDieOutcome, applySafeRoll, addChatMessage, addReaction,
  addSpectator, addBot, expireTurnIfNeeded, processBotTurn, finishMatch, reconcileWinner, MODES,
  APP_VERSION
};
