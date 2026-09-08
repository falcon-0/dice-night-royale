const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = 9;
const TURN_MS = 10_000;
const MAX_SPECTATORS = 20;
const MODES = Object.freeze({
  classic: { id: 'classic', name: 'Classic', targetScore: 100, turnMs: 10_000, riskStart: 16, riskStep: 8, description: 'The balanced original' },
  blitz: { id: 'blitz', name: 'Blitz', targetScore: 50, turnMs: 7_000, riskStart: 20, riskStep: 10, description: 'Fast, loud, and dangerous' },
  marathon: { id: 'marathon', name: 'Marathon', targetScore: 200, turnMs: 15_000, riskStart: 12, riskStep: 6, description: 'Long game, deeper strategy' }
});
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const RETIRED_FILE = process.env.RETIRED_FILE || path.join(__dirname, 'data', 'retired-rooms.json');
const ADMIN_TOKEN_FILE = process.env.ADMIN_TOKEN_FILE || path.join(__dirname, 'data', 'admin-token.txt');
const ADMIN_ENABLED = process.env.ENABLE_ADMIN === '1';
const rooms = new Map();
const retiredRooms = new Set();
const publicDir = path.join(__dirname, 'public');

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
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify([...rooms.values()], null, 2));
  } catch (error) {
    console.error('Could not save rooms:', error.message);
  }
}

function persistRetiredRooms() {
  fs.mkdirSync(path.dirname(RETIRED_FILE), { recursive: true });
  fs.writeFileSync(RETIRED_FILE, JSON.stringify([...retiredRooms], null, 2));
}

function loadRooms() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const room of saved) {
      if (room?.code && Array.isArray(room.players) && room.updatedAt > cutoff) {
        room.rollStreak ??= 0;
        room.doubleUsed ??= false;
        room.freezeUsed ??= false;
        room.schemaVersion = 3;
        room.matchId ??= 0;
        room.paused ??= false;
        room.turnDurationMs ??= TURN_MS;
        room.mode = MODES[room.mode] ? room.mode : 'classic';
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
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not load saved rooms:', error.message);
  }
}

function loadRetiredRooms() {
  try {
    for (const code of JSON.parse(fs.readFileSync(RETIRED_FILE, 'utf8'))) retiredRooms.add(String(code).toUpperCase());
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not load retired rooms:', error.message);
  }
}

loadRooms();
loadRetiredRooms();

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

function addSpectator(room, name) {
  const spectator = { id: crypto.randomUUID(), name, ...identitySecrets(), joinedAt: Date.now() };
  room.spectators.push(spectator);
  room.updatedAt = Date.now();
  return spectator;
}

function addPlayer(room, name) {
  const player = {
    id: crypto.randomUUID(),
    name,
    score: 0,
    shieldAvailable: true,
    frozen: false,
    stats: { rolls: 0, busts: 0, bestBank: 0 },
    ready: false,
    career: { games: 0, wins: 0, totalBanked: 0 },
    ...identitySecrets(),
    joinedAt: Date.now()
  };
  room.players.push(player);
  room.updatedAt = Date.now();
  return player;
}

function createRoom(name) {
  const code = roomCode();
  const room = {
    code,
    schemaVersion: 3,
    matchId: 0,
    hostId: null,
    players: [],
    spectators: [],
    mode: 'classic',
    phase: 'lobby',
    turnIndex: 0,
    turnScore: 0,
    rollStreak: 0,
    doubleUsed: false,
    freezeUsed: false,
    paused: false,
    turnDurationMs: TURN_MS,
    turnDeadline: null,
    lastRoll: null,
    winnerId: null,
    message: 'Waiting for players',
    chat: [],
    reactions: [],
    events: [],
    version: 1,
    updatedAt: Date.now()
  };
  const player = addPlayer(room, name);
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
    players: room.players.map(({ id, name, score, shieldAvailable, frozen, stats, ready, career }) => ({ id, name, score, shieldAvailable, frozen, stats, ready, career })),
    spectators: (room.spectators || []).map(({ id, name }) => ({ id, name })),
    meRole: room.players.some(player => player.id === playerId) ? 'player' : 'spectator',
    meRejoinCode: [...room.players, ...(room.spectators || [])].find(person => person.id === playerId)?.rejoinCode || null,
    mode: modeFor(room),
    turnIndex: room.turnIndex,
    turnScore: room.turnScore,
    rollStreak: room.rollStreak || 0,
    risk: riskFor(room),
    doubleRisk: riskFor(room, 15).percent,
    doubleUsed: room.doubleUsed || false,
    freezeUsed: room.freezeUsed || false,
    paused: room.paused || false,
    turnDurationMs: room.turnDurationMs || TURN_MS,
    nextBonusIn: 3 - ((room.rollStreak || 0) % 3),
    turnDeadline: room.turnDeadline,
    serverNow: Date.now(),
    lastRoll: room.lastRoll,
    winnerId: room.winnerId,
    message: room.message,
    chat: (room.chat || []).map(({ id, playerId: senderId, name, text, at }) => ({ id, playerId: senderId, name, text, at })),
    reactions: (room.reactions || []).slice(-12),
    events: (room.events || []).slice(-50),
    awards: awardsFor(room),
    allReady: room.players.length >= 2 && room.players.every(player => player.ready),
    targetScore: modeFor(room).targetScore,
    schemaVersion: 3,
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

function requireMember(room, playerId, sessionToken) {
  const member = [...room.players, ...(room.spectators || [])].find(person => person.id === playerId);
  if (!member || !secureEqual(member.sessionToken, sessionToken)) {
    throw Object.assign(new Error('Your private room session is invalid. Rejoin with your name and key.'), { status: 401 });
  }
  return member;
}

function nextTurn(room, message) {
  room.turnScore = 0;
  room.rollStreak = 0;
  room.doubleUsed = false;
  room.freezeUsed = false;
  const skipped = [];
  do {
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    if (room.players[room.turnIndex].frozen) {
      room.players[room.turnIndex].frozen = false;
      skipped.push(room.players[room.turnIndex].name);
    } else {
      break;
    }
  } while (skipped.length < room.players.length);
  room.turnDeadline = Date.now() + (room.turnDurationMs || TURN_MS);
  const freezeNote = skipped.length ? ` • ❄ ${skipped.join(', ')} ${skipped.length === 1 ? 'loses' : 'lose'} a turn` : '';
  room.message = (message || `${room.players[room.turnIndex].name}'s turn`) + freezeNote;
}

function expireTurnIfNeeded(room, now = Date.now()) {
  if (room.phase !== 'playing' || room.paused || !room.turnDeadline || room.turnDeadline > now) return false;
  const player = room.players[room.turnIndex];
  nextTurn(room, `${player.name} ran out of time — turn pot lost!`);
  addEvent(room, 'timeout', room.message, { actorId: player.id });
  bump(room);
  persistRooms();
  return true;
}

function action(room, playerId, type, targetId) {
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

  if (type === 'set_mode') {
    if (playerId !== room.hostId) throw Object.assign(new Error('Only FALCON can choose the mode.'), { status: 403 });
    if (room.phase !== 'lobby') throw Object.assign(new Error('Choose a mode before the match starts.'), { status: 409 });
    if (!MODES[targetId]) throw Object.assign(new Error('Unknown game mode.'), { status: 400 });
    room.mode = targetId;
    room.turnDurationMs = MODES[targetId].turnMs;
    room.players.forEach(player => { player.ready = false; });
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
    room.events = [];
    room.turnIndex = Math.floor(Math.random() * room.players.length);
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
      player.ready = false;
    });
    room.phase = 'lobby';
    room.turnIndex = 0;
    room.turnScore = 0;
    room.rollStreak = 0;
    room.doubleUsed = false;
    room.freezeUsed = false;
    room.turnDeadline = null;
    room.lastRoll = null;
    room.winnerId = null;
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
  if (type === 'freeze') {
    const target = room.players.find(candidate => candidate.id === targetId);
    if (!target || target.id === playerId) throw Object.assign(new Error('Choose another player to freeze.'), { status: 400 });
    if (player.score < 5) throw Object.assign(new Error('You need 5 banked points to freeze someone.'), { status: 409 });
    if (room.freezeUsed) throw Object.assign(new Error('You already used Freeze this turn.'), { status: 409 });
    if (target.frozen) throw Object.assign(new Error(`${target.name} is already frozen.`), { status: 409 });
    player.score -= 5;
    target.frozen = true;
    room.freezeUsed = true;
    room.turnDeadline = Date.now() + (room.turnDurationMs || TURN_MS);
    room.message = `${player.name} spent 5 points to freeze ${target.name}'s next turn!`;
    addEvent(room, 'freeze', room.message, { actorId: player.id, targetId: target.id, amount: 5 });
    bump(room);
    persistRooms();
    return;
  }

  if (type === 'roll' || type === 'double') {
    const doubled = type === 'double';
    if (doubled && room.turnScore < 10) throw Object.assign(new Error('Build a pot of 10 before a Double Roll.'), { status: 409 });
    if (doubled && room.doubleUsed) throw Object.assign(new Error('You already used your Double Roll this turn.'), { status: 409 });
    const risk = riskFor(room, doubled ? 15 : 0);
    const busted = crypto.randomInt(100) < risk.percent;
    const roll = busted ? 1 : crypto.randomInt(2, 7);
    room.lastRoll = roll;
    player.stats ??= { rolls: 0, busts: 0, bestBank: 0 };
    player.stats.rolls += 1;
    if (doubled) room.doubleUsed = true;
    if (busted) {
      player.stats.busts += 1;
      const shielded = player.shieldAvailable;
      if (shielded) {
        player.shieldAvailable = false;
        nextTurn(room, `${player.name} BUSTED — Safety Net blocked the −${risk.penalty} penalty!`);
      } else {
        player.score -= risk.penalty;
        nextTurn(room, `${player.name} BUSTED — pot lost and −${risk.penalty} points!`);
      }
      addEvent(room, 'bust', room.message, { actorId: player.id, die: 1, penalty: shielded ? 0 : risk.penalty, doubled });
    } else {
      const points = doubled ? roll * 2 : roll;
      const bonus = applySafeRoll(room, points);
      room.turnDeadline = Date.now() + (room.turnDurationMs || TURN_MS);
      room.message = doubled
        ? `${player.name} doubled ${roll} into ${points} points!${bonus ? ' + 10 HOT STREAK!' : ''}`
        : bonus
        ? `${player.name} hit a HOT STREAK — ${roll} + 10 bonus!`
        : `${player.name} rolled ${roll} — risk is climbing`;
      addEvent(room, bonus ? 'hot_streak' : doubled ? 'double' : 'roll', room.message, { actorId: player.id, die: roll, points, bonus });
    }
    bump(room);
    persistRooms();
    return;
  }

  if (type === 'hold') {
    if (room.turnScore < 1) throw Object.assign(new Error('Roll before you hold.'), { status: 409 });
    player.score += room.turnScore;
    const banked = room.turnScore;
    player.stats ??= { rolls: 0, busts: 0, bestBank: 0 };
    player.stats.bestBank = Math.max(player.stats.bestBank, banked);
    player.career ??= { games: 0, wins: 0, totalBanked: 0 };
    player.career.totalBanked += banked;
    if (player.score >= modeFor(room).targetScore) {
      room.phase = 'finished';
      room.winnerId = player.id;
      room.turnScore = 0;
      room.turnDeadline = null;
      room.message = `${player.name} wins with ${player.score} points!`;
      room.players.forEach(candidate => {
        candidate.career ??= { games: 0, wins: 0, totalBanked: 0 };
        candidate.career.games += 1;
      });
      player.career.wins += 1;
      addEvent(room, 'win', room.message, { actorId: player.id, score: player.score, matchId: room.matchId });
    } else {
      nextTurn(room, `${player.name} banked ${banked} points`);
      addEvent(room, 'bank', room.message, { actorId: player.id, amount: banked, score: player.score });
    }
    bump(room);
    persistRooms();
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
    player.ready = false;
  });
  room.phase = 'lobby';
  room.paused = false;
  room.turnIndex = 0;
  room.turnScore = 0;
  room.rollStreak = 0;
  room.doubleUsed = false;
  room.freezeUsed = false;
  room.turnDeadline = null;
  room.lastRoll = null;
  room.winnerId = null;
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
      career: player.career
    })),
    spectators: (room.spectators || []).map(({ id, name }) => ({ id, name }))
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
    room.players.forEach(player => { player.ready = false; });
    room.message = `FALCON selected ${MODES[payload.mode].name} mode`;
  } else if (type === 'score') {
    const player = room.players.find(candidate => candidate.id === payload.playerId);
    const delta = Math.round(Number(payload.delta));
    if (!player || !Number.isFinite(delta) || delta < -100 || delta > 100) throw Object.assign(new Error('Invalid score adjustment.'), { status: 400 });
    player.score += delta;
    room.message = `FALCON ${delta >= 0 ? 'added' : 'removed'} ${Math.abs(delta)} points ${delta >= 0 ? 'to' : 'from'} ${player.id === room.hostId ? 'FALCON' : player.name}`;
  } else if (type === 'remove_player') {
    const index = room.players.findIndex(candidate => candidate.id === payload.playerId);
    if (index < 0) throw Object.assign(new Error('Player not found.'), { status: 404 });
    if (room.players[index].id === room.hostId) throw Object.assign(new Error('FALCON cannot remove the admin.'), { status: 409 });
    const [removed] = room.players.splice(index, 1);
    if (index < room.turnIndex) room.turnIndex -= 1;
    else if (index === room.turnIndex) {
      room.turnIndex %= Math.max(1, room.players.length);
      room.turnScore = 0;
      room.rollStreak = 0;
      room.doubleUsed = false;
      room.freezeUsed = false;
      room.turnDeadline = Date.now() + room.turnDurationMs;
    }
    if (removed.id === room.winnerId || (room.players.length < 2 && room.phase === 'playing')) {
      resetMatch(room);
    }
    room.message = `${removed.name} was removed by FALCON`;
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
}

function isAdminRequest(req) {
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
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
      return sendJson(res, 200, { ok: true, rooms: rooms.size });
    }

    if (parts[0] === 'api' && parts[1] === 'admin') {
      if (!ADMIN_ENABLED) return sendJson(res, 404, { error: 'Not found.' });
      if (!isAdminRequest(req)) return sendJson(res, 401, { error: 'Invalid admin key.' });
      if (req.method === 'GET' && parts[2] === 'rooms' && parts.length === 3) {
        return sendJson(res, 200, { rooms: [...rooms.values()].map(adminRoomState) });
      }
      if (req.method === 'POST' && parts[2] === 'rooms' && parts[3]) {
        const code = parts[3].toUpperCase();
        const room = rooms.get(code);
        if (!room) return sendJson(res, 404, { error: 'Room not found.' });
        const payload = await readJson(req);
        if (payload.type === 'close') {
          rooms.delete(code);
          retiredRooms.add(code);
          persistRooms();
          persistRetiredRooms();
          return sendJson(res, 200, { closed: true, code });
        }
        adminAction(room, payload.type, payload);
        return sendJson(res, 200, { room: adminRoomState(room) });
      }
      return sendJson(res, 404, { error: 'Admin route not found.' });
    }

    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const { name } = await readJson(req);
      const cleaned = cleanName(name);
      if (!cleaned) return sendJson(res, 400, { error: 'Enter your name.' });
      const { room, player } = createRoom(cleaned);
      return sendJson(res, 201, { playerId: player.id, sessionToken: player.sessionToken, rejoinCode: player.rejoinCode, room: publicState(room, player.id) });
    }

    if (parts[0] === 'api' && parts[1] === 'rooms' && parts[2]) {
      const code = parts[2].toUpperCase();
      const room = rooms.get(code);
      const restoring = req.method === 'POST' && parts[3] === 'restore';
      if (restoring && retiredRooms.has(code)) return sendJson(res, 410, { error: 'This room was cleared. Create a new room.' });
      if (!room && !restoring) return sendJson(res, 404, { error: 'Room not found. Check the code.' });

      if (req.method === 'POST' && parts[3] === 'join') {
        const { name, role, rejoinCode } = await readJson(req);
        const cleaned = cleanName(name);
        if (!cleaned) return sendJson(res, 400, { error: 'Enter your name.' });
        const everyone = [...room.players, ...(room.spectators || [])];
        const returning = everyone.find(person => person.name.toLowerCase() === cleaned.toLowerCase());
        if (returning) {
          if (!secureEqual(returning.rejoinCode, rejoinCode)) {
            return sendJson(res, 401, { error: 'That name is saved. Enter its private 6-digit rejoin key.' });
          }
          returning.sessionToken = crypto.randomBytes(24).toString('base64url');
          const spectatorIndex = (room.spectators || []).findIndex(person => person.id === returning.id);
          if (role === 'player' && room.phase === 'lobby' && spectatorIndex >= 0) {
            if (room.players.length >= MAX_PLAYERS) return sendJson(res, 409, { error: 'The player table is full.' });
            room.spectators.splice(spectatorIndex, 1);
            Object.assign(returning, { score: 0, shieldAvailable: true, frozen: false, stats: { rolls: 0, busts: 0, bestBank: 0 }, ready: false, career: returning.career || { games: 0, wins: 0, totalBanked: 0 } });
            room.players.push(returning);
            room.players.forEach(candidate => { candidate.ready = false; });
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
          const spectator = addSpectator(room, cleaned);
          room.message = `${cleaned} joined the gallery`;
          addEvent(room, 'spectator_join', room.message, { actorId: spectator.id });
          bump(room);
          persistRooms();
          return sendJson(res, 200, { playerId: spectator.id, sessionToken: spectator.sessionToken, rejoinCode: spectator.rejoinCode, room: publicState(room, spectator.id) });
        }
        if (room.players.length >= MAX_PLAYERS) return sendJson(res, 409, { error: 'The player table is full. Join as a spectator.' });
        const player = addPlayer(room, cleaned);
        room.players.forEach(candidate => { candidate.ready = false; });
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
          doubleUsed: Boolean(snapshot.doubleUsed),
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
        const sessionToken = url.searchParams.get('sessionToken');
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
      rooms.delete(code);
      changed = true;
    }
  }
  if (changed) persistRooms();
}, 30 * 60 * 1000);
cleanup.unref();

const turnClock = setInterval(() => {
  for (const room of rooms.values()) expireTurnIfNeeded(room);
}, 250);
turnClock.unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Dice Night is live at http://${HOST}:${PORT}`);
  });
}

module.exports = { server, rooms, retiredRooms, createRoom, action, adminAction, publicState, riskFor, applySafeRoll, addChatMessage, addReaction, addSpectator, expireTurnIfNeeded, MODES };
