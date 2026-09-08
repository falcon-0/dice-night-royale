const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testDataFile = path.join(os.tmpdir(), `dice-night-test-${process.pid}.json`);
const testRetiredFile = path.join(os.tmpdir(), `dice-night-retired-test-${process.pid}.json`);
const testProfileFile = path.join(os.tmpdir(), `dice-night-profiles-test-${process.pid}.json`);
const testRecordsFile = path.join(os.tmpdir(), `dice-night-records-test-${process.pid}.json`);
process.env.DATA_FILE = testDataFile;
process.env.RETIRED_FILE = testRetiredFile;
process.env.PROFILE_FILE = testProfileFile;
process.env.RECORDS_FILE = testRecordsFile;
process.env.ENABLE_ADMIN = '1';
process.env.ADMIN_TOKEN = 'test-admin-key';
const {
  server, recordsStore, profiles, rooms, createRoom, action, adminAction, publicState, riskFor, riskDieFor,
  riskDieOutcome, applySafeRoll, addChatMessage, addReaction, addSpectator,
  expireTurnIfNeeded, processBotTurn, reconcileWinner, battleDieOutcome, MODES, APP_VERSION
} = require('../server');
const { readJsonFile, writeJsonFile } = require('../json-store');
const { ProfileService } = require('../profiles');
const { LocalRecordStore } = require('../records');
let baseUrl;

test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  fs.rmSync(testDataFile, { force: true });
  fs.rmSync(testRetiredFile, { force: true });
  fs.rmSync(testProfileFile, { force: true });
  fs.rmSync(testRecordsFile, { force: true });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

async function request(pathname, body, method = 'POST', headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, data: await response.json() };
}

test('creates a private lobby with one host', () => {
  const { room, player } = createRoom('Ada');
  const state = publicState(room, player.id);
  assert.equal(state.phase, 'lobby');
  assert.equal(state.players.length, 1);
  assert.equal(state.hostId, player.id);
  assert.equal(state.targetScore, 100);
  rooms.delete(room.code);
});

test('room state never exposes private profile identifiers', () => {
  const { room, player } = createRoom('Ada');
  player.profile = { id: 'private-id', profileCode: 'SECRET88', level: 4, achievements: [{ key: 'winner', name: 'Winner', icon: '🏆' }] };
  const profile = publicState(room, player.id).players[0].profile;
  assert.deepEqual(profile, { level: 4, featuredTitle: null, achievements: [{ key: 'winner', name: 'Winner', icon: '🏆' }] });
  assert.equal('id' in profile, false);
  assert.equal('profileCode' in profile, false);
  rooms.delete(room.code);
});

test('requires at least two players to start', () => {
  const { room, player } = createRoom('Ada');
  assert.throws(() => action(room, player.id, 'start'), /Invite at least one/);
  rooms.delete(room.code);
});

test('starts and rejects actions from the wrong player', () => {
  const { room, player } = createRoom('Ada');
  const second = { id: 'second', name: 'Lin', score: 0, ready: true, joinedAt: Date.now() };
  room.players.push(second);
  player.ready = true;
  action(room, player.id, 'start');
  const wrong = room.turnIndex === 0 ? second.id : player.id;
  assert.equal(room.phase, 'playing');
  assert.throws(() => action(room, wrong, 'roll'), /Wait for your turn/);
  rooms.delete(room.code);
});

test('holding banks points and advances the turn', () => {
  const { room, player } = createRoom('Ada');
  room.players.push({ id: 'second', name: 'Lin', score: 0, joinedAt: Date.now() });
  room.phase = 'playing';
  room.turnIndex = 0;
  room.turnScore = 12;
  action(room, player.id, 'hold');
  assert.equal(player.score, 12);
  assert.equal(room.turnScore, 0);
  assert.equal(room.turnIndex, 1);
  rooms.delete(room.code);
});

test('reaching 100 finishes the game', () => {
  const { room, player } = createRoom('Ada');
  room.players.push({ id: 'second', name: 'Lin', score: 0, joinedAt: Date.now() });
  room.phase = 'playing';
  room.turnIndex = 0;
  room.turnScore = 5;
  player.score = 95;
  action(room, player.id, 'hold');
  assert.equal(room.phase, 'finished');
  assert.equal(room.winnerId, player.id);
  assert.equal(player.career.wins, 1);
  assert.equal(player.career.games, 1);
  assert.equal(publicState(room, player.id).awards.length, 2);
  rooms.delete(room.code);
});

test('risk climbs while the roll-1 penalty stays at 5', () => {
  const { room } = createRoom('Ada');
  assert.deepEqual(riskFor(room), { percent: 16, penalty: 5 });
  room.rollStreak = 4;
  assert.deepEqual(riskFor(room), { percent: 48, penalty: 5 });
  assert.equal(riskFor(room, 15).percent, 63);
  room.rollStreak = 20;
  assert.equal(riskFor(room).percent, 75);
  rooms.delete(room.code);
});

test('Risk Die begins half skulls, grows deadlier, and has five reward faces', () => {
  const { room } = createRoom('Ada');
  assert.deepEqual(riskDieFor(room), { percent: 50, skullFaces: 5, rewardFaces: 5, penalty: 5 });
  assert.equal(riskDieOutcome(room, () => 0).busted, true);
  const values = [9, 4];
  assert.deepEqual(riskDieOutcome(room, () => values.shift()).reward, 30);
  room.rollStreak = 4;
  assert.deepEqual(riskDieFor(room), { percent: 58, skullFaces: 7, rewardFaces: 5, penalty: 5 });
  rooms.delete(room.code);
});

test('Battle Dice has distinct normal, skull, and high-reward outcomes', () => {
  const { room } = createRoom('Ada');
  assert.deepEqual(battleDieOutcome(room, 'roll', () => 1), { dieKind: 'normal', busted: true, face: 1, damage: 0, selfDamage: 5 });
  assert.deepEqual(battleDieOutcome(room, 'roll', () => 6), { dieKind: 'normal', busted: false, face: 6, damage: 6, selfDamage: 0 });
  const values = [5, 4];
  const risk = battleDieOutcome(room, 'risk_die', () => values.shift());
  assert.equal(risk.busted, false);
  assert.equal(risk.damage, 30);
  assert.equal(risk.dieKind, 'risk');
  rooms.delete(room.code);
});

test('Battle Dice starts everyone at 30 health and crowns the last player standing', () => {
  const { room, player } = createRoom('Falcon');
  action(room, player.id, 'add_bot', 'balanced');
  const rival = room.players[1];
  action(room, player.id, 'set_mode', 'battle');
  action(room, player.id, 'ready');
  action(room, player.id, 'start');
  assert.deepEqual(room.players.map(candidate => candidate.score), [30, 30]);
  assert.equal(publicState(room, player.id).gameSystem, 'battle');
  adminAction(room, 'score', { playerId: rival.id, delta: -30 });
  assert.equal(room.phase, 'finished');
  assert.equal(room.winnerId, player.id);
  rooms.delete(room.code);
});

test('Battle Dice attacks, advances after one roll, skips knocked-out seats, and finishes', () => {
  const { room, player } = createRoom('Falcon');
  action(room, player.id, 'add_bot', 'balanced');
  action(room, player.id, 'add_bot', 'bold');
  action(room, player.id, 'set_mode', 'battle');
  action(room, player.id, 'ready');
  action(room, player.id, 'start');
  room.turnIndex = 0;

  const firstRival = room.players[1];
  const secondRival = room.players[2];
  action(room, player.id, 'roll', null, () => 6);
  assert.equal(firstRival.score, 24);
  assert.equal(room.turnIndex, 1);
  assert.equal(room.lastOutcome.damage, 6);

  const deadlyValues = [5, 4];
  action(room, firstRival.id, 'risk_die', null, () => deadlyValues.shift());
  assert.equal(secondRival.score, 0);
  assert.equal(room.turnIndex, 0);
  assert.equal(room.lastOutcome.dieKind, 'risk');
  assert.equal(room.lastOutcome.damage, 30);

  const finishingValues = [5, 4];
  action(room, player.id, 'risk_die', null, () => finishingValues.shift());
  assert.equal(firstRival.score, -6);
  assert.equal(room.phase, 'finished');
  assert.equal(room.winnerId, player.id);
  rooms.delete(room.code);
});

test('Battle admin score changes advance past eliminated current players', () => {
  const { room, player } = createRoom('Falcon');
  action(room, player.id, 'add_bot', 'balanced');
  action(room, player.id, 'add_bot', 'bold');
  action(room, player.id, 'set_mode', 'battle');
  action(room, player.id, 'ready');
  action(room, player.id, 'start');
  room.turnIndex = 0;

  adminAction(room, 'score', { playerId: player.id, delta: -30 });
  assert.equal(player.score, 0);
  assert.notEqual(room.turnIndex, 0);
  room.turnIndex = 0;
  assert.throws(() => action(room, player.id, 'roll', null, () => 6), /knocked out/);
  rooms.delete(room.code);
});

test('removing a Battle rival immediately crowns the only standing player', () => {
  const { room, player } = createRoom('Falcon');
  action(room, player.id, 'add_bot', 'balanced');
  action(room, player.id, 'add_bot', 'bold');
  action(room, player.id, 'set_mode', 'battle');
  action(room, player.id, 'ready');
  action(room, player.id, 'start');
  room.players[1].score = 0;
  const standingRival = room.players[2];

  adminAction(room, 'remove_player', { playerId: standingRival.id });
  assert.equal(room.phase, 'finished');
  assert.equal(room.winnerId, player.id);
  rooms.delete(room.code);
});

test('hidden legacy double-roll action is rejected', () => {
  const { room, player } = createRoom('Falcon');
  room.players.push({ id: 'second', name: 'Lin', score: 0, joinedAt: Date.now() });
  room.phase = 'playing';
  room.turnIndex = 0;
  assert.throws(() => action(room, player.id, 'double'), /Unknown action/);
  rooms.delete(room.code);
});

test('optional profiles can be created, signed into, and authenticated', async () => {
  const created = await request('/api/profiles', { displayName: 'Nova', pin: '246810' });
  assert.equal(created.status, 201);
  assert.equal(created.data.profile.profileCode.length, 8);
  assert.equal(created.data.profile.achievements[0].key, 'profile_created');

  const rejected = await request('/api/profiles/login', { code: created.data.profile.profileCode, pin: '111111' });
  assert.equal(rejected.status, 401);
  const login = await request('/api/profiles/login', { code: created.data.profile.profileCode, pin: '246810' });
  assert.equal(login.status, 200);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const repeated = await request('/api/profiles/login', { code: created.data.profile.profileCode, pin: '246810' });
    assert.equal(repeated.status, 200);
  }

  const response = await fetch(`${baseUrl}/api/profiles/me`, { headers: { Authorization: `Bearer ${login.data.profileToken}` } });
  assert.equal(response.status, 200);
  const authenticated = await response.json();
  assert.equal(authenticated.profile.displayName, 'Nova');
});

test('saved profiles can sign in with their player name and PIN', async () => {
  const first = await request('/api/profiles', { displayName: 'Back Again', pin: '135790' });
  const second = await request('/api/profiles', { displayName: 'Back Again', pin: '975310' });

  const firstLogin = await request('/api/profiles/login', { code: 'back again', pin: '135790' });
  assert.equal(firstLogin.status, 200);
  assert.equal(firstLogin.data.profile.id, first.data.profile.id);

  const secondLogin = await request('/api/profiles/login', { code: 'BACK AGAIN', pin: '975310' });
  assert.equal(secondLogin.status, 200);
  assert.equal(secondLogin.data.profile.id, second.data.profile.id);
});

test('equivalent profile-code formatting shares one failed-login limit', async () => {
  const created = await request('/api/profiles', { displayName: 'Throttle Test', pin: '246810' });
  const code = created.data.profile.profileCode;
  const variants = [
    `-${code}`, `${code}-`, `${code.slice(0, 2)}-${code.slice(2)}`, `${code.slice(0, 3)} ${code.slice(3)}`,
    `.${code}`, `${code}!`, `${code.slice(0, 4)}/${code.slice(4)}`, `(${code})`
  ];
  for (const variant of variants) {
    const rejected = await request('/api/profiles/login', { code: variant, pin: '111111' });
    assert.equal(rejected.status, 401);
  }
  const limited = await request('/api/profiles/login', { code, pin: '111111' });
  assert.equal(limited.status, 429);
});

test('an expired 10-second clock loses the pot and passes the turn', () => {
  const { room } = createRoom('Ada');
  room.players.push({ id: 'second', name: 'Lin', score: 0, joinedAt: Date.now() });
  room.phase = 'playing';
  room.turnIndex = 0;
  room.turnScore = 21;
  room.rollStreak = 3;
  room.turnDeadline = Date.now() - 1;
  assert.equal(expireTurnIfNeeded(room), true);
  assert.equal(room.turnIndex, 1);
  assert.equal(room.turnScore, 0);
  assert.equal(room.rollStreak, 0);
  assert.ok(room.turnDeadline > Date.now());
  rooms.delete(room.code);
});

test('every third safe roll adds a 10-point Hot Streak bonus', () => {
  const { room } = createRoom('Ada');
  assert.equal(applySafeRoll(room, 4), 0);
  assert.equal(applySafeRoll(room, 5), 0);
  assert.equal(applySafeRoll(room, 3), 10);
  assert.equal(room.turnScore, 22);
  assert.equal(room.rollStreak, 3);
  rooms.delete(room.code);
});

test('room chat sanitizes messages and rate-limits spam', () => {
  const { room, player } = createRoom('Ada');
  addChatMessage(room, player.id, '  good   luck everyone  ', 1000);
  assert.equal(room.chat[0].text, 'good luck everyone');
  assert.equal(room.chat[0].name, 'Ada');
  assert.throws(() => addChatMessage(room, player.id, 'spam', 1200), /slower/);
  addChatMessage(room, player.id, 'A'.repeat(200), 1600);
  assert.equal(room.chat[1].text.length, 160);
  rooms.delete(room.code);
});

test('freeze costs 5 points and skips the target next turn', () => {
  const { room, player } = createRoom('Ada');
  const second = { id: 'second', name: 'Lin', score: 8, frozen: false, shieldAvailable: true, stats: { rolls: 0, busts: 0, bestBank: 0 }, joinedAt: Date.now() };
  room.players.push(second);
  room.phase = 'playing';
  room.turnIndex = 0;
  room.turnDeadline = Date.now() + 10000;
  player.score = 5;
  action(room, player.id, 'freeze', second.id);
  assert.equal(player.score, 0);
  assert.equal(second.frozen, true);
  room.turnDeadline = Date.now() - 1;
  expireTurnIfNeeded(room);
  assert.equal(room.turnIndex, 0);
  assert.equal(second.frozen, false);
  assert.equal(player.turnsTaken, 1);
  assert.equal(second.turnsTaken, 1);
  rooms.delete(room.code);
});

test('admin can pause, change timing, adjust scores, announce, and reset', () => {
  const { room, player } = createRoom('Falcon');
  const second = { id: 'second', name: 'Lin', score: 0, frozen: false, shieldAvailable: true, stats: { rolls: 0, busts: 0, bestBank: 0 }, joinedAt: Date.now() };
  room.players.push(second);
  room.phase = 'playing';
  room.turnDeadline = Date.now() + 10_000;

  adminAction(room, 'set_timer', { seconds: 20 });
  assert.equal(room.turnDurationMs, 20_000);
  adminAction(room, 'pause');
  assert.equal(room.paused, true);
  assert.equal(expireTurnIfNeeded(room, Date.now() + 60_000), false);
  adminAction(room, 'resume');
  assert.equal(room.paused, false);

  adminAction(room, 'score', { playerId: second.id, delta: 15 });
  assert.equal(second.score, 15);
  adminAction(room, 'announce', { text: 'Final round!' });
  assert.equal(room.chat.at(-1).name, 'FALCON · ADMIN');
  adminAction(room, 'clear_chat');
  assert.equal(room.chat.length, 0);
  adminAction(room, 'reset');
  assert.equal(room.phase, 'lobby');
  assert.equal(player.score, 0);
  assert.equal(second.score, 0);
  rooms.delete(room.code);
});

test('mode selection resets readiness and changes the target and timer', () => {
  const { room, player } = createRoom('Falcon');
  room.players.push({ id: 'second', name: 'Lin', score: 0, ready: true, joinedAt: Date.now() });
  action(room, player.id, 'set_mode', 'blitz');
  assert.equal(room.mode, 'blitz');
  assert.equal(room.turnDurationMs, 10000);
  assert.equal(publicState(room, player.id).targetScore, 50);
  assert.equal(room.players.every(candidate => candidate.ready === false), true);
  rooms.delete(room.code);
});

test('Falcon control deck can select a mode and explicitly force start', () => {
  const { room } = createRoom('Falcon');
  room.players.push({ id: 'second', name: 'Lin', score: 0, ready: false, joinedAt: Date.now() });
  adminAction(room, 'set_mode', { mode: 'marathon' });
  assert.equal(room.mode, 'marathon');
  adminAction(room, 'force_start');
  assert.equal(room.phase, 'playing');
  assert.equal(room.players.every(player => player.ready), true);
  rooms.delete(room.code);
});

test('admin removal safely resets an abandoned match or missing winner', () => {
  const { room } = createRoom('Falcon');
  const second = { id: 'second', name: 'Lin', score: 50, ready: true, stats: { rolls: 2, busts: 0, bestBank: 20 }, joinedAt: Date.now() };
  room.players.push(second);
  room.phase = 'playing';
  room.turnScore = 19;
  adminAction(room, 'remove_player', { playerId: second.id });
  assert.equal(room.phase, 'lobby');
  assert.equal(room.turnScore, 0);
  assert.equal(room.players[0].score, 0);

  const third = { id: 'third', name: 'Mira', score: 100, ready: true, stats: { rolls: 5, busts: 1, bestBank: 30 }, joinedAt: Date.now() };
  room.players.push(third);
  room.phase = 'finished';
  room.winnerId = third.id;
  adminAction(room, 'remove_player', { playerId: third.id });
  assert.equal(room.phase, 'lobby');
  assert.equal(room.winnerId, null);
  rooms.delete(room.code);
});

test('admin removal preserves an active participant snapshot for final records', () => {
  const { room } = createRoom('Falcon');
  const removed = { id: 'second', name: 'Lin', score: 22, ready: true, profileId: 'profile-lin', stats: { rolls: 7, busts: 1, bestBank: 12 }, matchBanked: 22, matchFreezes: 1, joinedAt: Date.now() };
  room.players.push(removed, { id: 'third', name: 'Mira', score: 10, ready: true, stats: { rolls: 2, busts: 0, bestBank: 10 }, joinedAt: Date.now() });
  room.phase = 'playing';
  adminAction(room, 'remove_player', { playerId: removed.id });
  assert.equal(room.phase, 'playing');
  assert.equal(room.departedPlayers.length, 1);
  assert.equal(room.departedPlayers[0].profileId, 'profile-lin');
  assert.equal(room.departedPlayers[0].stats.rolls, 7);
  rooms.delete(room.code);
});

test('removing a Showdown contender crowns the only tied leader left', () => {
  const { room, player } = createRoom('Falcon');
  action(room, player.id, 'add_bot', 'careful');
  action(room, player.id, 'add_bot', 'bold');
  const contender = room.players[1];
  room.phase = 'playing';
  room.mode = 'showdown';
  room.matchId = 2;
  room.showdownSuddenDeath = true;
  room.showdownContenders = [player.id, contender.id];
  adminAction(room, 'remove_player', { playerId: contender.id });
  assert.equal(room.phase, 'finished');
  assert.equal(room.winnerId, player.id);
  rooms.delete(room.code);
});

test('spectators can watch, chat, and react without taking a seat', () => {
  const { room } = createRoom('Falcon');
  const spectator = addSpectator(room, 'Watcher');
  const state = publicState(room, spectator.id);
  assert.equal(state.meRole, 'spectator');
  assert.equal(state.players.length, 1);
  assert.equal(state.spectators.length, 1);
  addChatMessage(room, spectator.id, 'Big roll!', 1000);
  addReaction(room, spectator.id, '🔥', 2000);
  assert.equal(room.chat.at(-1).name, 'Watcher');
  assert.equal(room.reactions.at(-1).emoji, '🔥');
  assert.throws(() => addReaction(room, spectator.id, '🔥', 2500), /slower/);
  rooms.delete(room.code);
});

test('HTTP sessions protect identities, rotate on keyed rejoin, and promote spectators', async () => {
  const created = await request('/api/rooms', { name: 'Falcon' });
  assert.equal(created.status, 201);
  assert.equal(created.data.rejoinCode.length, 6);
  const { code } = created.data.room;

  const guest = await request(`/api/rooms/${code}/join`, { name: 'Nova', role: 'player' });
  assert.equal(guest.status, 200);
  const impersonation = await request(`/api/rooms/${code}/join`, { name: 'Nova', role: 'player' });
  assert.equal(impersonation.status, 401);

  const stolenAction = await request(`/api/rooms/${code}/action`, {
    playerId: created.data.playerId,
    sessionToken: guest.data.sessionToken,
    type: 'ready'
  });
  assert.equal(stolenAction.status, 401);

  const rejoined = await request(`/api/rooms/${code}/join`, { name: 'Nova', role: 'player', rejoinCode: guest.data.rejoinCode });
  assert.equal(rejoined.status, 200);
  assert.notEqual(rejoined.data.sessionToken, guest.data.sessionToken);
  const oldSession = await request(`/api/rooms/${code}?playerId=${guest.data.playerId}`, null, 'GET', { Authorization: `Bearer ${guest.data.sessionToken}` });
  assert.equal(oldSession.status, 401);
  const queryCredential = await request(`/api/rooms/${code}?playerId=${rejoined.data.playerId}&sessionToken=${rejoined.data.sessionToken}`, null, 'GET');
  assert.equal(queryCredential.status, 401);
  const currentSession = await request(`/api/rooms/${code}?playerId=${rejoined.data.playerId}`, null, 'GET', { Authorization: `Bearer ${rejoined.data.sessionToken}` });
  assert.equal(currentSession.status, 200);

  const watcher = await request(`/api/rooms/${code}/join`, { name: 'Orbit', role: 'spectator' });
  assert.equal(watcher.data.room.meRole, 'spectator');
  const promoted = await request(`/api/rooms/${code}/join`, { name: 'Orbit', role: 'player', rejoinCode: watcher.data.rejoinCode });
  assert.equal(promoted.data.room.meRole, 'player');
  assert.equal(promoted.data.room.players.length, 3);
  rooms.delete(code);
});

test('private admin HTTP routes require the configured key', async () => {
  const unauthorized = await request('/api/admin/rooms', null, 'GET');
  assert.equal(unauthorized.status, 401);
  const authorized = await request('/api/admin/rooms', null, 'GET', { Authorization: 'Bearer test-admin-key' });
  assert.equal(authorized.status, 200);
});

test('health identifies the V3.1 JSON server', async () => {
  const response = await request('/api/health', null, 'GET');
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { ok: true, rooms: rooms.size, storage: 'json', version: APP_VERSION });
  assert.equal(APP_VERSION, '3.1.0');
});

test('every built-in game mode starts with a 10-second turn', () => {
  assert.deepEqual(Object.values(MODES).map(mode => mode.turnMs), [10000, 10000, 10000, 10000, 10000]);
});

test('public leaderboard ranks profiles without exposing identity secrets', async () => {
  const created = await request('/api/profiles', { displayName: 'Public Hero', pin: '135790' });
  assert.equal(created.status, 201);
  const response = await request('/api/leaderboard?limit=50', null, 'GET');
  assert.equal(response.status, 200);
  const entry = response.data.leaderboard.find(player => player.displayName === 'Public Her');
  assert.ok(entry);
  assert.deepEqual(Object.keys(entry).sort(), [
    'achievementCount', 'bestBank', 'displayName', 'games', 'level', 'rank',
    'totalBanked', 'winRate', 'wins', 'xp'
  ]);
  const serialized = JSON.stringify(response.data);
  for (const privateField of ['profileCode', 'pinHash', 'pinSalt', 'tokenHash', 'lastSeenAt', 'id']) {
    assert.equal(serialized.includes(`"${privateField}"`), false);
  }
});

test('host can add and remove auto-ready practice players', () => {
  const { room, player } = createRoom('Falcon');
  action(room, player.id, 'add_bot', 'bold');
  const bot = room.players[1];
  assert.equal(bot.isBot, true);
  assert.equal(bot.botStyle, 'bold');
  assert.equal(bot.ready, true);
  assert.equal(publicState(room, player.id).players[1].isBot, true);
  assert.equal(publicState(room, player.id).allReady, true);
  assert.throws(() => action(room, bot.id, 'add_bot', 'bold'), /Only the host/);
  action(room, player.id, 'remove_bot', bot.id);
  assert.equal(room.players.length, 1);
  rooms.delete(room.code);
});

test('practice player schedules a human-like turn and acts through normal rules', () => {
  const { room, player } = createRoom('Falcon');
  action(room, player.id, 'add_bot', 'balanced');
  const bot = room.players[1];
  room.phase = 'playing';
  room.matchId = 1;
  room.turnNumber = 1;
  room.turnIndex = 1;
  room.turnDeadline = Date.now() + 100000;
  assert.equal(processBotTurn(room, 1000, () => 0.5), false);
  assert.equal(processBotTurn(room, 3000, () => 0.5), true);
  assert.equal(bot.stats.rolls, 1);
  rooms.delete(room.code);
});

test('Five-Round Showdown finishes only after every player completes five turns', () => {
  const { room, player } = createRoom('Falcon');
  action(room, player.id, 'add_bot', 'balanced');
  const second = room.players[1];
  room.mode = 'showdown';
  room.phase = 'playing';
  room.matchId = 1;
  room.turnIndex = 0;
  room.turnDeadline = Date.now() + 100000;
  player.turnsTaken = 4;
  second.turnsTaken = 4;
  player.score = 10;
  second.score = 5;
  room.turnScore = 1;
  action(room, player.id, 'hold');
  assert.equal(room.phase, 'playing');
  assert.equal(player.turnsTaken, 5);
  room.turnScore = 1;
  action(room, second.id, 'hold');
  assert.equal(room.phase, 'finished');
  assert.equal(room.winnerId, player.id);
  assert.equal(publicState(room, player.id).targetScore, null);
  rooms.delete(room.code);
});

test('tied Showdown plays complete sudden-death rounds until a winner emerges', () => {
  const { room, player } = createRoom('Falcon');
  action(room, player.id, 'add_bot', 'careful');
  const second = room.players[1];
  room.mode = 'showdown';
  room.phase = 'playing';
  room.matchId = 1;
  room.turnIndex = 0;
  room.turnDeadline = Date.now() + 100000;
  player.turnsTaken = 4;
  second.turnsTaken = 4;
  player.score = 9;
  second.score = 9;
  room.turnScore = 1;
  action(room, player.id, 'hold');
  room.turnScore = 1;
  action(room, second.id, 'hold');
  assert.equal(room.phase, 'playing');
  assert.equal(room.showdownSuddenDeath, true);
  assert.equal(room.showdownRoundLimit, 6);
  assert.deepEqual(room.players.map(candidate => candidate.turnsTaken), [5, 5]);

  room.turnScore = 2;
  action(room, player.id, 'hold');
  assert.equal(room.phase, 'playing');
  room.turnScore = 1;
  action(room, second.id, 'hold');
  assert.equal(room.phase, 'finished');
  assert.equal(room.winnerId, player.id);
  assert.deepEqual(room.players.map(candidate => candidate.turnsTaken), [6, 6]);
  rooms.delete(room.code);
});

test('Showdown sudden death excludes players who were not tied for the lead', () => {
  const { room, player } = createRoom('Falcon');
  action(room, player.id, 'add_bot', 'careful');
  action(room, player.id, 'add_bot', 'bold');
  const second = room.players[1];
  const third = room.players[2];
  room.mode = 'showdown';
  room.phase = 'playing';
  room.matchId = 1;
  room.turnIndex = 0;
  room.turnDeadline = Date.now() + 100000;
  for (const candidate of room.players) candidate.turnsTaken = 4;
  player.score = 10;
  second.score = 10;
  third.score = 1;

  for (const candidate of [player, second, third]) {
    room.turnScore = 1;
    action(room, candidate.id, 'hold');
  }
  assert.equal(room.showdownSuddenDeath, true);
  assert.deepEqual(room.showdownContenders, [player.id, second.id]);
  assert.equal(room.turnIndex, 0);

  room.turnScore = 2;
  action(room, player.id, 'hold');
  room.turnScore = 1;
  action(room, second.id, 'hold');
  assert.equal(room.phase, 'finished');
  assert.equal(room.winnerId, player.id);
  assert.equal(third.turnsTaken, 5);
  rooms.delete(room.code);
});

test('atomic JSON storage recovers from a corrupted primary file', () => {
  const file = path.join(os.tmpdir(), `dice-night-atomic-${process.pid}-${Date.now()}.json`);
  try {
    writeJsonFile(file, { generation: 1 });
    writeJsonFile(file, { generation: 2 });
    fs.writeFileSync(file, '{broken');
    assert.deepEqual(readJsonFile(file, null), { generation: 1 });
    writeJsonFile(file, { generation: 3 });
    fs.writeFileSync(file, '{broken-again');
    assert.deepEqual(readJsonFile(file, null), { generation: 1 });
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.bak`, { force: true });
  }
});

test('winner reconciliation repairs an over-target room exactly once', () => {
  const { room, player } = createRoom('Falcon');
  action(room, player.id, 'add_bot', 'balanced');
  room.mode = 'marathon';
  room.phase = 'playing';
  room.matchId = 3;
  player.score = 269;
  assert.equal(reconcileWinner(room), true);
  assert.equal(room.phase, 'finished');
  assert.equal(room.winnerId, player.id);
  assert.equal(player.career.wins, 1);
  assert.equal(reconcileWinner(room), false);
  assert.equal(player.career.wins, 1);
  rooms.delete(room.code);
});

test('profile and room display names are capped at ten characters server-side', async () => {
  const createdProfile = await request('/api/profiles', { displayName: 'LongPlayerName', pin: '112233' });
  assert.equal(createdProfile.status, 201);
  assert.equal(createdProfile.data.profile.displayName, 'LongPlayer');

  const createdRoom = await request('/api/rooms', { name: 'ABCDEFGHIJKLMNO' });
  assert.equal(createdRoom.status, 201);
  assert.equal(createdRoom.data.room.players[0].name, 'ABCDEFGHIJ');
  rooms.delete(createdRoom.data.room.code);
});

test('startup profile migration removes the retired identity and its private references', async () => {
  const profileFile = path.join(os.tmpdir(), `dice-night-profile-migration-${process.pid}-${Date.now()}.json`);
  const recordsFile = path.join(os.tmpdir(), `dice-night-record-migration-${process.pid}-${Date.now()}.json`);
  try {
    writeJsonFile(profileFile, {
      profiles: [
        { id: 'remove-id', displayName: 'ALOYINLEPONSMALLIE', pinHash: 'private', pinSalt: 'private', games: 2, wins: 1 },
        { id: 'keep-id', displayName: 'LongKeeperName', pinHash: 'private', pinSalt: 'private', games: 1, wins: 0 }
      ],
      sessions: [
        { profileId: 'remove-id', tokenHash: 'private-remove' },
        { profileId: 'keep-id', tokenHash: 'private-keep' }
      ],
      achievements: [
        { profileId: 'remove-id', key: 'first_win' },
        { profileId: 'keep-id', key: 'profile_created' }
      ],
      completedMatches: ['remove-id:ROOM1:1', 'keep-id:ROOM2:1']
    });
    writeJsonFile(recordsFile, [
      { id: 'ROOM1:1', players: [{ profileId: 'remove-id', playerName: 'ALOYINLEPONSMALLIE' }] },
      { id: 'ROOM2:1', players: [{ profileId: 'keep-id', playerName: 'LongKeeperName' }] }
    ]);

    const service = new ProfileService({ file: profileFile });
    const migration = await service.initialize();
    assert.deepEqual(migration.removedProfiles, [{ profileId: 'remove-id', displayName: 'ALOYINLEPONSMALLIE' }]);
    assert.deepEqual(service.local.profiles.map(profile => ({ id: profile.id, name: profile.displayName })), [{ id: 'keep-id', name: 'LongKeeper' }]);
    assert.equal(service.local.sessions.some(session => session.profileId === 'remove-id'), false);
    assert.equal(service.local.achievements.some(item => item.profileId === 'remove-id'), false);
    assert.equal(service.local.completedMatches.some(item => String(item).startsWith('remove-id:')), false);

    const store = new LocalRecordStore({ file: recordsFile });
    await store.initialize();
    assert.equal(await store.removeProfiles(['remove-id']), 1);
    assert.deepEqual(store.matches.map(match => match.id), ['ROOM2:1']);
  } finally {
    for (const file of [profileFile, `${profileFile}.bak`, recordsFile, `${recordsFile}.bak`]) fs.rmSync(file, { force: true });
  }
});

test('startup profile migration renames ISSA and reserves Founder for FALCON', async () => {
  const profileFile = path.join(os.tmpdir(), `dice-night-honor-migration-${process.pid}-${Date.now()}.json`);
  try {
    writeJsonFile(profileFile, {
      profiles: [
        { id: 'falcon-id', displayName: 'FALCON', xp: 0 },
        { id: 'bishop-id', displayName: 'Bishop01', xp: 600 },
        { id: 'guest-id', displayName: 'Guest', xp: 0, featuredTitleKey: 'founder' }
      ],
      sessions: [],
      achievements: [
        { profileId: 'falcon-id', key: 'profile_created' },
        { profileId: 'bishop-id', key: 'profile_created' },
        { profileId: 'guest-id', key: 'profile_created' },
        { profileId: 'guest-id', key: 'founder' }
      ],
      completedMatches: []
    });

    const service = new ProfileService({ file: profileFile });
    const migration = await service.initialize();
    assert.deepEqual(migration.renamedProfiles, [{ profileId: 'bishop-id', from: 'Bishop01', to: 'ISSA' }]);
    const issa = await service.byId('bishop-id');
    const falcon = await service.byId('falcon-id');
    const guest = await service.byId('guest-id');
    assert.equal(issa.displayName, 'ISSA');
    assert.equal(issa.featuredTitle.label, '×4 Dice Night Champion');
    assert.equal(issa.achievements.some(item => item.key === 'triple_champion'), true);
    assert.equal(falcon.featuredTitle.key, 'founder');
    assert.equal(falcon.achievements.some(item => item.key === 'founder'), true);
    assert.equal(guest.featuredTitle, null);
    assert.equal(guest.achievements.some(item => item.key === 'founder'), false);
    assert.equal(guest.achievements.find(item => item.key === 'profile_created').name, 'First Roll');
  } finally {
    for (const file of [profileFile, `${profileFile}.bak`]) fs.rmSync(file, { force: true });
  }
});

test('admin profile APIs expose safe fields, update rooms, enforce titles, and fully delete', async () => {
  const created = await request('/api/profiles', { displayName: 'ManageMe', pin: '445566' });
  assert.equal(created.status, 201);
  const profileId = created.data.profile.id;
  const roomResponse = await request('/api/rooms', { name: 'ignored', profileToken: created.data.profileToken });
  assert.equal(roomResponse.status, 201);
  const roomCode = roomResponse.data.room.code;
  const deletedPlayerId = roomResponse.data.playerId;
  const survivor = await request(`/api/rooms/${roomCode}/join`, { name: 'Survivor', role: 'player' });
  assert.equal(survivor.status, 200);
  addChatMessage(rooms.get(roomCode), deletedPlayerId, 'Remove this authored history');
  rooms.get(roomCode).events.push({ type: 'test', text: 'authored event', details: { actorId: deletedPlayerId } });

  const unauthorized = await request('/api/admin/profiles', null, 'GET');
  assert.equal(unauthorized.status, 401);
  const listed = await request('/api/admin/profiles', null, 'GET', { Authorization: 'Bearer test-admin-key' });
  assert.equal(listed.status, 200);
  const listedProfile = listed.data.profiles.find(profile => profile.id === profileId);
  assert.ok(listedProfile);
  const serializedList = JSON.stringify(listedProfile);
  for (const secret of ['pinHash', 'pinSalt', 'tokenHash', 'profileToken', 'profileCode']) assert.equal(serializedList.includes(secret), false);

  const updated = await request(`/api/admin/profiles/${profileId}`, {
    displayName: 'RenamedLonger', xp: 900, games: 3, wins: 2, featuredTitle: 'triple_champion'
  }, 'PATCH', { Authorization: 'Bearer test-admin-key' });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.profile.displayName, 'RenamedLon');
  assert.equal(updated.data.profile.xp, 900);
  assert.equal(updated.data.profile.games, 3);
  assert.equal(updated.data.profile.wins, 2);
  assert.equal(updated.data.profile.featuredTitle.key, 'triple_champion');
  assert.equal(rooms.get(roomCode).players[0].name, 'RenamedLon');
  assert.equal(rooms.get(roomCode).players[0].profile.featuredTitle.key, 'triple_champion');

  const invalidWins = await request(`/api/admin/profiles/${profileId}`, { games: 1, wins: 2 }, 'PATCH', { Authorization: 'Bearer test-admin-key' });
  assert.equal(invalidWins.status, 400);
  const forbiddenFounder = await request(`/api/admin/profiles/${profileId}`, { featuredTitle: 'founder' }, 'PATCH', { Authorization: 'Bearer test-admin-key' });
  assert.equal(forbiddenFounder.status, 403);

  const falcon = await request('/api/profiles', { displayName: 'FALCON', pin: '778899' });
  const founder = await request(`/api/admin/profiles/${falcon.data.profile.id}`, { featuredTitle: 'founder' }, 'PATCH', { Authorization: 'Bearer test-admin-key' });
  assert.equal(founder.status, 200);
  assert.equal(founder.data.profile.featuredTitle.key, 'founder');
  await request(`/api/admin/profiles/${falcon.data.profile.id}`, null, 'DELETE', { Authorization: 'Bearer test-admin-key' });

  profiles.local.completedMatches.push(`${profileId}:ARCHIVE:1`);
  recordsStore.matches.push({ id: 'ARCHIVE:1', players: [{ profileId, playerName: 'RenamedLon' }] });
  const deleted = await request(`/api/admin/profiles/${profileId}`, null, 'DELETE', { Authorization: 'Bearer test-admin-key' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.deleted, true);
  assert.equal(deleted.data.roomsUpdated, 1);
  assert.equal(deleted.data.roomsRetired, 0);
  assert.equal(rooms.get(roomCode).players.length, 1);
  assert.equal(rooms.get(roomCode).hostId, survivor.data.playerId);
  assert.equal(JSON.stringify(rooms.get(roomCode)).includes(profileId), false);
  assert.equal(JSON.stringify(rooms.get(roomCode)).includes(deletedPlayerId), false);
  assert.equal(recordsStore.matches.some(match => (match.players || []).some(player => player.profileId === profileId)), false);
  assert.equal(profiles.local.sessions.some(session => session.profileId === profileId), false);
  assert.equal(profiles.local.achievements.some(item => item.profileId === profileId), false);
  assert.equal(profiles.local.completedMatches.some(item => String(item).startsWith(`${profileId}:`)), false);
  const expired = await fetch(`${baseUrl}/api/profiles/me`, { headers: { Authorization: `Bearer ${created.data.profileToken}` } });
  assert.equal(expired.status, 401);
  rooms.delete(roomCode);
});

test('admin leaderboard reset keeps profiles but clears competitive records', async () => {
  const before = await profiles.leaderboard(50);
  assert.ok(before.length > 0);
  await profiles.resetLeaderboard();
  await recordsStore.reset();
  const after = await profiles.leaderboard(50);
  assert.equal(after.length, before.length);
  assert.equal(after.every(entry => entry.games === 0 && entry.wins === 0 && entry.totalBanked === 0 && entry.xp === 0), true);
  assert.equal((await recordsStore.records()).summary.matches, 0);
});
