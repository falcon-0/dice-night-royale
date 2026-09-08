const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testDataFile = path.join(os.tmpdir(), `dice-night-test-${process.pid}.json`);
const testRetiredFile = path.join(os.tmpdir(), `dice-night-retired-test-${process.pid}.json`);
const testProfileFile = path.join(os.tmpdir(), `dice-night-profiles-test-${process.pid}.json`);
process.env.DATA_FILE = testDataFile;
process.env.RETIRED_FILE = testRetiredFile;
process.env.PROFILE_FILE = testProfileFile;
process.env.ADMIN_TOKEN = 'test-admin-key';
const { server, rooms, createRoom, action, adminAction, publicState, riskFor, riskDieFor, riskDieOutcome, applySafeRoll, addChatMessage, addReaction, addSpectator, expireTurnIfNeeded } = require('../server');
let baseUrl;

test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  fs.rmSync(testDataFile, { force: true });
  fs.rmSync(testRetiredFile, { force: true });
  fs.rmSync(testProfileFile, { force: true });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

async function request(pathname, body, method = 'POST') {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
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

test('optional profiles can be created, signed into, and authenticated', async () => {
  const created = await request('/api/profiles', { displayName: 'Nova', pin: '246810' });
  assert.equal(created.status, 201);
  assert.equal(created.data.profile.profileCode.length, 8);
  assert.equal(created.data.profile.achievements[0].key, 'profile_created');

  const rejected = await request('/api/profiles/login', { code: created.data.profile.profileCode, pin: '111111' });
  assert.equal(rejected.status, 401);
  const login = await request('/api/profiles/login', { code: created.data.profile.profileCode, pin: '246810' });
  assert.equal(login.status, 200);

  const response = await fetch(`${baseUrl}/api/profiles/me`, { headers: { Authorization: `Bearer ${login.data.profileToken}` } });
  assert.equal(response.status, 200);
  const authenticated = await response.json();
  assert.equal(authenticated.profile.displayName, 'Nova');
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
  assert.equal(room.turnDurationMs, 7000);
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
  const oldSession = await request(`/api/rooms/${code}?playerId=${guest.data.playerId}&sessionToken=${guest.data.sessionToken}`, null, 'GET');
  assert.equal(oldSession.status, 401);
  const currentSession = await request(`/api/rooms/${code}?playerId=${rejoined.data.playerId}&sessionToken=${rejoined.data.sessionToken}`, null, 'GET');
  assert.equal(currentSession.status, 200);

  const watcher = await request(`/api/rooms/${code}/join`, { name: 'Orbit', role: 'spectator' });
  assert.equal(watcher.data.room.meRole, 'spectator');
  const promoted = await request(`/api/rooms/${code}/join`, { name: 'Orbit', role: 'player', rejoinCode: watcher.data.rejoinCode });
  assert.equal(promoted.data.room.meRole, 'player');
  assert.equal(promoted.data.room.players.length, 3);
  rooms.delete(code);
});

test('private admin HTTP routes stay hidden unless explicitly enabled', async () => {
  const response = await request('/api/admin/rooms', null, 'GET');
  assert.equal(response.status, 404);
});
