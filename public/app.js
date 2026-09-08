const $ = selector => document.querySelector(selector);
const state = { mode: 'create', joinRole: 'player', code: null, playerId: null, sessionToken: null, rejoinCode: null, profileToken: localStorage.getItem('dice-night:profile-token'), profile: null, room: null, polling: null, acting: false, chatOpen: false, timelineOpen: false, chatSeen: null, lastChatId: null, celebratedWinner: null, leaderboardSort: 'wins', soundEnabled: localStorage.getItem('dice-night:sound') !== 'off', seenReactions: new Set() };
let audioContext;
const activeAudioNodes = new Set();
let serverOffset = 0;

const screens = { home: $('#home-screen'), game: $('#game-screen') };
const pipMap = {
  1: ['mc'], 2: ['tl', 'br'], 3: ['tl', 'mc', 'br'],
  4: ['tl', 'tr', 'bl', 'br'], 5: ['tl', 'tr', 'mc', 'bl', 'br'],
  6: ['tl', 'tr', 'ml', 'mr', 'bl', 'br']
};

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-tab').forEach(tab => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $('#room-field').classList.toggle('hidden', mode !== 'join');
  $('#room-input').required = mode === 'join';
  $('#entry-submit').innerHTML = mode === 'create' ? 'Create a room <span>→</span>' : 'Join the table <span>→</span>';
  $('#entry-error').textContent = '';
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function renderProfile() {
  const signedIn = Boolean(state.profile);
  $('#profile-signed-out').classList.toggle('hidden', signedIn);
  $('#profile-signed-in').classList.toggle('hidden', !signedIn);
  if (!signedIn) {
    $('#profile-strip').innerHTML = 'Playing as a guest. <button id="profile-strip-button" type="button">Save your stats</button>';
    $('#profile-strip-button').addEventListener('click', () => $('#profile-dialog').showModal());
    return;
  }
  $('#name-input').value = state.profile.displayName;
  $('#profile-strip').innerHTML = `Level ${state.profile.level} <b>${escapeHtml(state.profile.displayName)}</b> · ${state.profile.stats.wins} wins <button id="profile-strip-button" type="button">View profile</button>`;
  $('#profile-strip-button').addEventListener('click', () => $('#profile-dialog').showModal());
  const stats = state.profile.stats;
  const title = state.profile.featuredTitle;
  const featuredTitle = title ? `<div class="profile-featured-title ${title.variant === 'champion' ? 'champion-title' : 'founder-title'}"><span>${escapeHtml(title.icon)}</span>${escapeHtml(title.label)}</div>` : '';
  $('#profile-card').innerHTML = `<h3>${escapeHtml(state.profile.displayName)} · Level ${state.profile.level}</h3>${featuredTitle}<p>Profile code <b>${escapeHtml(state.profile.profileCode)}</b> · ${state.profile.xp} XP</p><div class="profile-stats"><span>${stats.games} games</span><span>${stats.wins} wins</span><span>${stats.totalRolls} rolls</span><span>${stats.totalBanked} banked</span><span>Best bank ${stats.bestBank}</span></div><div class="achievement-grid">${state.profile.achievements.length ? state.profile.achievements.map(item => `<span class="${item.key === 'triple_champion' ? 'honor-achievement champion-title' : item.key === 'founder' ? 'honor-achievement founder-title' : ''}" title="${escapeHtml(item.description || '')}">${item.icon || '◆'} ${escapeHtml(item.name || item.key)}</span>`).join('') : '<span>Play a match to unlock badges</span>'}</div>`;
}

async function loadProfile() {
  if (!state.profileToken) { renderProfile(); return; }
  try {
    const data = await api('/api/profiles/me', { headers: { Authorization: `Bearer ${state.profileToken}` } });
    state.profile = data.profile;
  } catch {
    state.profileToken = null;
    state.profile = null;
    localStorage.removeItem('dice-night:profile-token');
  }
  renderProfile();
}

function acceptProfile(data) {
  state.profileToken = data.profileToken;
  state.profile = data.profile;
  localStorage.setItem('dice-night:profile-token', state.profileToken);
  $('#profile-error').textContent = '';
  renderProfile();
  showToast(`Signed in as ${state.profile.displayName}`);
}

function saveSession() {
  localStorage.setItem(`dice-night:${state.code}`, JSON.stringify({ playerId: state.playerId, sessionToken: state.sessionToken, rejoinCode: state.rejoinCode }));
  history.replaceState(null, '', `/?room=${state.code}`);
}

function playSound(kind) {
  if (!state.soundEnabled) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    audioContext.resume?.();
    const now = audioContext.currentTime;
    const notes = {
      roll: [[180, .03, .05], [240, .09, .05], [320, .15, .07]],
      safe: [[440, 0, .08], [620, .08, .1]],
      bust: [[150, 0, .22], [90, .12, .32]],
      bank: [[520, 0, .08], [720, .08, .08], [900, .16, .12]],
      chat: [[720, 0, .05], [900, .07, .08]],
      win: [
        [392, 0, .24], [523, 0, .24], [659, 0, .24],
        [523, .34, .2], [659, .34, .2], [784, .34, .2],
        [587, .68, .2], [740, .68, .2], [880, .68, .2],
        [659, 1.02, .36], [784, 1.02, .36], [988, 1.02, .36],
        [784, 1.52, .16], [880, 1.7, .16], [988, 1.88, .18], [1175, 2.08, .5],
        [523, 2.7, .25], [659, 2.7, .25], [784, 2.7, .25],
        [587, 3.05, .25], [740, 3.05, .25], [880, 3.05, .25],
        [659, 3.42, .95], [784, 3.42, .95], [1047, 3.42, .95]
      ]
    }[kind] || [];
    for (const [frequency, delay, duration] of notes) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = kind === 'bust' ? 'sawtooth' : kind === 'win' ? 'triangle' : 'sine';
      oscillator.frequency.setValueAtTime(frequency, now + delay);
      gain.gain.setValueAtTime(.0001, now + delay);
      gain.gain.exponentialRampToValueAtTime(kind === 'roll' ? .055 : .11, now + delay + .01);
      gain.gain.exponentialRampToValueAtTime(.0001, now + delay + duration);
      oscillator.connect(gain).connect(audioContext.destination);
      activeAudioNodes.add(oscillator);
      oscillator.addEventListener('ended', () => activeAudioNodes.delete(oscillator), { once: true });
      oscillator.start(now + delay);
      oscillator.stop(now + delay + duration + .02);
    }
  } catch { /* Sound is an enhancement; the game still works if audio is blocked. */ }
}

function updateSoundControl() {
  const button = $('#sound-toggle');
  button.setAttribute('aria-pressed', String(!state.soundEnabled));
  button.setAttribute('aria-label', state.soundEnabled ? 'Mute game sounds' : 'Turn on game sounds');
  button.innerHTML = `${state.soundEnabled ? '🔊' : '🔇'} <span>${state.soundEnabled ? 'Sound' : 'Muted'}</span>`;
}

function setSoundEnabled(enabled) {
  state.soundEnabled = enabled;
  localStorage.setItem('dice-night:sound', enabled ? 'on' : 'off');
  if (!enabled) {
    for (const node of activeAudioNodes) {
      try { node.stop(); } catch { /* A scheduled note may already have stopped. */ }
    }
    activeAudioNodes.clear();
  } else {
    playSound('safe');
  }
  updateSoundControl();
}

function openWinnerResults() {
  const dialog = $('#winner-dialog');
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => $('#winner-name').focus());
}

function celebrate(winnerId) {
  const celebrationId = `${state.room?.matchId || 0}:${winnerId}`;
  if (!winnerId || state.celebratedWinner === celebrationId) return;
  state.celebratedWinner = celebrationId;
  openWinnerResults();
  playSound('win');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#c7f06a', '#ffd074', '#ff8f79', '#88d9ff', '#f5f0e5'];
  for (let index = 0; index < 70; index += 1) {
    const piece = document.createElement('i');
    piece.className = 'confetti';
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = colors[index % colors.length];
    piece.style.setProperty('--drift', `${Math.random() * 180 - 90}px`);
    piece.style.animationDelay = `${Math.random() * .8}s`;
    piece.style.transform = `rotate(${Math.random() * 180}deg)`;
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 3900);
  }
}

function enterGame(room) {
  state.room = room;
  state.code = room.code;
  screens.home.classList.add('hidden');
  screens.game.classList.remove('hidden');
  saveSession();
  render(room);
  if (!state.polling) state.polling = setInterval(poll, 700);
}

function returnToJoin(message) {
  clearInterval(state.polling);
  state.polling = null;
  if (state.code) localStorage.removeItem(`dice-night:${state.code}`);
  screens.game.classList.add('hidden');
  screens.home.classList.remove('hidden');
  setMode('join');
  $('#room-input').value = state.code || '';
  $('#entry-error').textContent = message;
  history.replaceState(null, '', state.code ? `/?room=${state.code}` : '/');
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1800);
}

function leaderboardPlayer(row) {
  const stats = row.stats || {};
  const games = Number(row.games ?? row.gamesPlayed ?? row.games_played ?? stats.games ?? 0);
  const wins = Number(row.wins ?? stats.wins ?? 0);
  const totalBanked = Number(row.totalBanked ?? row.total_banked_points ?? stats.totalBanked ?? 0);
  return {
    displayName: String(row.displayName ?? row.playerName ?? row.player_name ?? row.name ?? 'Mystery player'),
    level: Math.max(1, Number(row.level ?? 1)),
    games,
    wins,
    totalBanked,
    bestBank: Number(row.bestBank ?? row.best_bank ?? stats.bestBank ?? 0),
    achievementCount: Number(row.achievementCount ?? row.achievement_count ?? row.achievements?.length ?? 0),
    isMe: Boolean(row.isMe)
  };
}

function leaderboardMarkup(rows) {
  if (!rows.length) return '<div class="leaderboard-empty">Complete the first match to claim the table.</div>';
  const podium = rows.slice(0, 3).map((player, index) => `<article class="podium-card ${player.isMe ? 'is-me' : ''}"><span class="podium-rank">${index + 1}</span><strong>${escapeHtml(player.displayName)}</strong><p>${player.wins} wins · Level ${player.level}</p></article>`).join('');
  const table = rows.slice(3).map((player, index) => {
    const winRate = player.games ? Math.round((player.wins / player.games) * 100) : 0;
    return `<div class="leaderboard-row ${player.isMe ? 'is-me' : ''}"><span class="leaderboard-rank">#${index + 4}</span><span class="leaderboard-player"><strong>${escapeHtml(player.displayName)}</strong><small>Level ${player.level} · ${player.achievementCount} badges</small></span><span class="leaderboard-stat">${player.wins}<small>Wins</small></span><span class="leaderboard-stat">${player.totalBanked}<small>Banked</small></span><span class="leaderboard-stat">${winRate}%<small>Win rate</small></span></div>`;
  }).join('');
  return `<div class="leaderboard-podium">${podium}</div>${table ? `<div class="leaderboard-table">${table}</div>` : ''}`;
}

async function loadLeaderboard() {
  const box = $('#leaderboard-content');
  box.innerHTML = '<div class="leaderboard-loading">Reading the record book…</div>';
  try {
    const data = await api(`/api/leaderboard?sort=${encodeURIComponent(state.leaderboardSort)}&limit=50`);
    const rawRows = Array.isArray(data) ? data : data.leaderboard || data.players || [];
    const rows = rawRows.map(leaderboardPlayer);
    const valueFor = state.leaderboardSort === 'banked' ? player => player.totalBanked : state.leaderboardSort === 'games' ? player => player.games : player => player.wins;
    rows.sort((left, right) => valueFor(right) - valueFor(left) || right.wins - left.wins || left.displayName.localeCompare(right.displayName));
    box.innerHTML = leaderboardMarkup(rows);
    $('#leaderboard-updated').textContent = `Updated ${new Date(data.updatedAt || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  } catch (error) {
    box.innerHTML = `<div class="leaderboard-empty leaderboard-error">${escapeHtml(error.message)}<button id="retry-leaderboard" type="button">Try again</button></div>`;
    $('#leaderboard-updated').textContent = 'The rankings could not load.';
    $('#retry-leaderboard')?.addEventListener('click', loadLeaderboard);
  }
}

async function poll() {
  if (!state.code || !state.playerId || state.acting) return;
  try {
    const { room } = await api(`/api/rooms/${state.code}?playerId=${encodeURIComponent(state.playerId)}`, { headers: { Authorization: `Bearer ${state.sessionToken}` } });
    if (!state.room || room.version !== state.room.version) {
      const oldMessage = state.room?.message;
      const rolled = oldMessage !== room.message && /(rolled| hit .* for \d+ damage)/i.test(room.message);
      state.room = room;
      render(room, rolled);
      if (oldMessage !== room.message) {
        if (room.message.includes('BUSTED') || room.message.includes('ran out of time')) playSound('bust');
        else if (room.message.includes('banked')) playSound('bank');
        else if (room.phase === 'finished') celebrate(room.winnerId);
        else if (rolled) playSound('safe');
      }
    }
  } catch (error) {
    if (/private room session|Room not found/i.test(error.message)) return returnToJoin(error.message);
    $('#game-error').textContent = error.message;
  }
}

function playerCard(player, index, room) {
  const active = room.phase === 'playing' && index === room.turnIndex;
  const winner = room.winnerId === player.id;
  const admin = player.id === room.hostId;
  const displayName = admin ? 'FALCON' : player.name;
  const bot = Boolean(player.isBot);
  const showdown = room.mode?.id === 'showdown';
  const battle = room.mode?.id === 'battle';
  const title = player.profile?.featuredTitle;
  const titleVariant = title?.variant === 'champion' ? 'champion' : title?.variant === 'founder' ? 'founder' : '';
  const titleLabel = title ? `${title.icon} ${title.label}` : '';
  const titleBadge = title ? `<span class="player-title ${titleVariant}-title">${escapeHtml(title.icon)} ${escapeHtml(title.label)}</span>` : '';
  const roundLimit = room.showdown?.turnLimit || 5;
  const progress = showdown
    ? Math.max(0, Math.min(100, (Number(player.turnsTaken || 0) / roundLimit) * 100))
    : battle
    ? Math.max(0, Math.min(100, (Number(player.score) / 30) * 100))
    : Math.max(0, Math.min(100, (player.score / Math.max(1, room.targetScore || room.mode?.targetScore || 100)) * 100));
  const canRemoveBot = bot && room.phase === 'lobby' && room.meId === room.hostId;
  const status = room.phase === 'lobby'
    ? (player.ready ? 'READY' : 'WAITING')
    : battle
      ? `${player.score} health${player.score <= 0 ? ', knocked out' : ''}`
    : showdown
      ? `${player.score} points, ${player.turnsTaken || 0} of ${roundLimit} turns complete`
      : `${player.score} of ${room.targetScore || room.mode?.targetScore || 100} points`;
  return `<article class="player-card ${active ? 'active' : ''} ${winner ? 'winner' : ''} ${admin ? 'admin' : ''} ${bot ? 'bot' : ''} ${player.ready ? 'ready' : ''} ${titleVariant ? `honor-card ${titleVariant}-card` : ''} ${battle && player.score <= 0 ? 'eliminated' : ''}" ${active ? 'aria-current="true"' : ''} aria-label="${escapeHtml(displayName)}, ${escapeHtml(status)}${titleLabel ? `, ${escapeHtml(titleLabel)}` : ''}${active ? ', current turn' : ''}">
    <div class="player-top"><span class="avatar">${admin ? '♛' : bot ? '⚙' : escapeHtml(player.name[0].toUpperCase())}</span><span class="player-name">${escapeHtml(displayName)}</span>${admin ? '<span class="admin-badge">ADMIN</span>' : ''}${bot ? `<span class="bot-badge">${escapeHtml((player.botStyle || 'BOT').toUpperCase())}</span>` : ''}${player.id === room.meId ? '<span class="you">YOU</span>' : ''}<span class="player-perks" title="${player.frozen ? 'Next turn frozen' : player.shieldAvailable ? 'Safety Net available' : ''}">${player.frozen ? '❄' : player.shieldAvailable ? '◈' : ''}</span></div>
    ${titleBadge}
    <div class="player-score"><strong>${player.score}</strong><span>${room.phase === 'lobby' ? player.ready ? 'READY' : 'WAITING' : battle ? 'HEALTH' : showdown ? `${player.turnsTaken || 0}/${roundLimit} TURNS` : `/ ${room.targetScore || room.mode?.targetScore || 100}`}</span></div>
    ${room.phase !== 'lobby' ? `<div class="player-progress" aria-hidden="true"><span style="width:${progress}%"></span></div>` : ''}
    ${active ? '<span class="current-turn">CURRENT TURN</span>' : ''}
    ${canRemoveBot ? `<button class="bot-card-action" type="button" data-remove-bot="${escapeHtml(player.id)}" aria-label="Remove ${escapeHtml(displayName)}">Remove bot</button>` : ''}
  </article>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function displayName(person, room = state.room) {
  return person?.id === room?.hostId ? 'FALCON' : person?.name || 'Unknown player';
}

function renderDice(room, animate = false) {
  const normal = $('#normal-die-face');
  const risk = $('#risk-die-face');
  const outcome = room.lastOutcome || (room.lastRoll ? {
    dieKind: room.lastRollKind === 'risk' ? 'risk' : 'normal',
    busted: room.lastRoll === 1,
    face: room.lastRoll,
    damage: room.lastReward || null
  } : null);
  const normalValue = outcome?.dieKind === 'normal' && Number(outcome.face) >= 1 ? Number(outcome.face) : 5;
  normal.innerHTML = pipMap[normalValue].map(position => `<span class="pip ${position}"></span>`).join('');
  risk.textContent = outcome?.dieKind === 'risk' ? (outcome.busted ? '☠' : `+${outcome.damage || room.lastReward || 0}`) : '☠';
  normal.classList.toggle('is-result', outcome?.dieKind === 'normal');
  risk.classList.toggle('is-result', outcome?.dieKind === 'risk');
  const status = !outcome
    ? 'Choose either die.'
    : outcome.dieKind === 'risk'
    ? outcome.busted ? 'Deadly Risk Die: SKULL!' : `Deadly Risk Die: +${outcome.damage || room.lastReward} ${room.mode?.id === 'battle' ? 'damage' : 'points'}!`
    : outcome.busted ? 'Normal Die: rolled 1 and busted.' : `Normal Die: rolled ${outcome.face}.`;
  $('#dice-result-status').textContent = status;
  if (animate) {
    const die = outcome?.dieKind === 'risk' ? risk : normal;
    die.classList.remove('rolling');
    void die.offsetWidth;
    die.classList.add('rolling');
  }
}

function render(room, animateRoll = false) {
  state.room = room;
  if (room.serverNow) serverOffset = Date.now() - room.serverNow;
  saveSession();
  $('#room-code').textContent = room.code;
  $('#invite-code').textContent = room.code;
  state.rejoinCode ||= room.meRejoinCode;
  $('#session-key span').textContent = state.rejoinCode ? `Key ${state.rejoinCode}` : 'Rejoin key';
  const admin = room.players.find(player => player.id === room.hostId);
  const visibleMessage = admin?.name ? room.message.split(admin.name).join('FALCON') : room.message;
  $('#status-message').textContent = visibleMessage;
  $('#last-action-die').textContent = room.lastOutcome?.dieKind === 'risk'
    ? room.lastOutcome.busted ? '☠ SKULL' : `☠ +${room.lastOutcome.damage || room.lastReward}`
    : room.lastRoll ? `🎲 ${room.lastRoll}` : room.phase === 'lobby' ? 'READY' : 'PLAY';
  $('#game-error').textContent = '';
  renderChat(room);
  renderTimeline(room);
  renderEventFeed(room);
  renderReactions(room);

  const cards = room.players.map((player, index) => playerCard(player, index, room));
  while (cards.length < room.maxPlayers) cards.push('<article class="player-card empty">OPEN SEAT</article>');
  $('#players').innerHTML = cards.join('');
  const spectators = room.spectators || [];
  $('#spectator-row').classList.toggle('hidden', spectators.length === 0);
  $('#spectator-row').innerHTML = spectators.length ? `<strong>WATCHING · ${spectators.length}</strong> ${spectators.map(person => `<span>${escapeHtml(person.id === room.meId ? 'You' : person.name)}</span>`).join('')}` : '';

  $('#lobby-panel').classList.toggle('hidden', room.phase !== 'lobby');
  $('#play-panel').classList.toggle('hidden', room.phase !== 'playing');
  $('#winner-panel').classList.toggle('hidden', room.phase !== 'finished');
  if (room.phase !== 'finished' && $('#winner-dialog').open) $('#winner-dialog').close();

  if (room.phase === 'lobby') {
    const count = room.players.length;
    $('#lobby-count').textContent = `${count} of ${room.maxPlayers} seats filled`;
    const host = room.hostId === room.meId;
    const me = room.players.find(player => player.id === room.meId);
    document.querySelectorAll('[data-game-mode]').forEach(button => {
      const active = button.dataset.gameMode === room.mode.id;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = !host;
    });
    $('#ready-button').classList.toggle('hidden', room.meRole !== 'player');
    $('#ready-button').textContent = me?.ready ? '✓ Ready — tap to cancel' : 'I’m ready';
    $('#ready-button').classList.toggle('is-ready', Boolean(me?.ready));
    $('#ready-note').textContent = room.meRole === 'spectator'
      ? `Watching ${room.mode.name} mode from the gallery.`
      : room.allReady ? 'Everyone is ready. FALCON can launch!' : `${room.players.filter(player => player.ready).length} of ${count} players ready`;
    $('#start-button').classList.toggle('hidden', !host);
    $('#start-button').disabled = !room.allReady;
    $('#start-button').textContent = count < 2 ? 'Invite a friend to start' : room.allReady ? `Launch ${room.mode.name}` : 'Waiting for everyone';
    $('#bot-tools').classList.toggle('hidden', !host);
    $('#add-bot-button').disabled = count >= room.maxPlayers || state.acting;
    $('#add-bot-button').textContent = count >= room.maxPlayers ? 'Table full' : '＋ Add practice bot';
    if (host && Array.isArray(room.botStyles) && room.botStyles.length) {
      const select = $('#bot-difficulty');
      const selected = select.value;
      select.innerHTML = room.botStyles.map(style => `<option value="${escapeHtml(style.id)}">${escapeHtml(style.name)}</option>`).join('');
      if ([...select.options].some(option => option.value === selected)) select.value = selected;
      else if ([...select.options].some(option => option.value === 'balanced')) select.value = 'balanced';
    }
  } else {
    $('#bot-tools').classList.add('hidden');
  }

  if (room.phase === 'playing') {
    const current = room.players[room.turnIndex];
    const myTurn = current.id === room.meId;
    const battle = room.mode.id === 'battle';
    const me = room.players.find(player => player.id === room.meId);
    const canAct = myTurn && (!battle || Number(me?.score) > 0);
    $('#play-panel').dataset.gameSystem = battle ? 'battle' : 'royale';
    $('#active-game-label').textContent = battle ? 'GAME 2 · BATTLE DICE' : 'GAME 1 · ROYALE RACE';
    const currentName = displayName(current, room).toUpperCase();
    $('#turn-label').textContent = room.paused ? 'TABLE PAUSED' : myTurn && !canAct ? 'KNOCKED OUT' : myTurn ? 'YOUR TURN' : room.meRole === 'spectator' ? `WATCHING ${currentName}` : `${currentName}'S TURN`;
    $('#turn-score').textContent = room.turnScore;
    $('#risk-percent').textContent = `${room.risk?.percent ?? 16}%`;
    $('#risk-fill').style.width = `${room.risk?.percent ?? 16}%`;
    $('#risk-penalty').textContent = `Roll 1 penalty: −${room.risk?.penalty ?? 5} points`;
    $('#normal-die-reward').textContent = battle ? 'Hit the next rival for 2–6' : 'Build 2–6 points';
    $('#normal-die-risk').textContent = battle ? 'Roll 1 · lose 5 health' : `${room.risk?.percent ?? 16}% bust · −${room.risk?.penalty ?? 5} saved`;
    $('#streak-progress').textContent = room.nextBonusIn === 1 ? 'Next safe roll earns +10' : `${room.nextBonusIn ?? 3} rolls to +10 bonus`;
    $('#roll-button').disabled = room.paused || !canAct || state.acting;
    $('#hold-button').disabled = room.paused || !canAct || room.turnScore < 1 || state.acting;
    $('#double-risk').textContent = `${room.riskDieRisk?.percent ?? 50}% bust · ${room.riskDieRisk?.skullFaces ?? 5} skulls`;
    $('#double-button').disabled = room.paused || !canAct || state.acting;
    $('#roll-button').setAttribute('aria-label', battle ? 'Roll the Normal Die to attack the next standing rival' : 'Roll the Normal Die');
    $('#double-button').setAttribute('aria-label', battle ? 'Roll the Deadly Risk Die to attack the next standing rival' : 'Roll the Deadly Risk Die');
    $('#freeze-button').disabled = room.paused || !canAct || !me || me.score < 5 || (battle && me.score <= 5) || room.freezeUsed || room.players.length < 2 || state.acting;
    $('#turn-pot-panel').classList.toggle('hidden', battle);
    $('#normal-risk-panel').classList.toggle('hidden', battle);
    $('#streak-chip').classList.toggle('hidden', battle);
    $('#battle-help').classList.toggle('hidden', !battle);
    $('#hold-button').classList.toggle('hidden', battle);
    renderDice(room, animateRoll);
  }

  if (room.phase === 'finished') {
    const winner = room.players.find(player => player.id === room.winnerId);
    if (!winner) {
      $('#winner-name').textContent = 'Winner left the room';
      $('#winner-score').textContent = 'FALCON can begin a fresh match.';
      $('#winner-stats').textContent = '';
      $('#awards').innerHTML = '';
      $('#room-records').innerHTML = '';
      $('#restart-button').classList.add('hidden');
      $('#winner-waiting').classList.remove('hidden');
      openWinnerResults();
      return;
    }
    const winnerName = winner.id === room.hostId ? 'FALCON' : winner.name;
    $('#winner-name').textContent = winner.id === room.meId ? 'You won!' : `${winnerName} wins!`;
    $('#winner-score').textContent = room.mode.id === 'battle' ? `${winner.score} health remaining — last player standing.` : `${winner.score} points — what a run.`;
    const stats = winner.stats || { rolls: 0, busts: 0, bestBank: 0 };
    $('#winner-stats').textContent = `${stats.rolls} rolls · ${stats.busts} busts · ${stats.bestBank} biggest bank`;
    $('#awards').innerHTML = (room.awards || []).map(award => {
      const owner = room.players.find(player => player.id === award.playerId);
      return `<article><span>${award.icon}</span><div><b>${escapeHtml(award.title)}</b><strong>${escapeHtml(owner?.id === room.hostId ? 'FALCON' : owner?.name || '')}</strong><small>${escapeHtml(award.value)}</small></div></article>`;
    }).join('');
    $('#room-records').innerHTML = `<h3>Final standings</h3>${[...room.players].sort((a, b) => b.score - a.score).map((player, index) => `<p><b>#${index + 1} ${escapeHtml(player.id === room.hostId ? 'FALCON' : player.name)}</b><span>${player.score} ${room.mode.id === 'battle' ? 'health' : 'points'} · ${player.stats?.rolls || 0} rolls · ${player.stats?.busts || 0} busts</span></p>`).join('')}`;
    const host = room.hostId === room.meId;
    $('#restart-button').classList.toggle('hidden', !host);
    $('#winner-waiting').classList.toggle('hidden', host);
    celebrate(room.winnerId);
  }
}

function renderEventFeed(room) {
  const icons = { roll: '🎲', risk_die: '☠', battle_hit: '⚔', battle_bust: '💀', hot_streak: '🔥', bank: '💰', bust: '💥', freeze: '❄', timeout: '⏱', win: '🏆', start: '▶', ready: '✓', mode: '◆', player_join: '+', player_leave: '−', spectator_join: '◉', lobby: '↻', admin: '♛' };
  const roomHost = room.players.find(player => player.id === room.hostId);
  const events = [...(room.events || [])].slice(-3).reverse();
  $('#event-feed').innerHTML = events.length ? events.map(item => {
    const text = roomHost?.name ? item.text.split(roomHost.name).join('FALCON') : item.text;
    const time = new Date(item.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `<li><span class="event-icon" aria-hidden="true">${icons[item.type] || '•'}</span><div><p title="${escapeHtml(text)}">${escapeHtml(text)}</p><time datetime="${new Date(item.at).toISOString()}">${time}</time></div></li>`;
  }).join('') : '<li class="event-empty">New rolls and table moments will appear here.</li>';
}

function renderTimeline(room) {
  const icons = { roll: '🎲', risk_die: '☠', battle_hit: '⚔', battle_bust: '💀', hot_streak: '🔥', bank: '💰', bust: '💥', freeze: '❄', timeout: '⏱', win: '🏆', start: '▶', ready: '✓', mode: '◆', player_join: '+', spectator_join: '◉', lobby: '↻', admin: '♛' };
  const events = [...(room.events || [])].reverse();
  const roomHost = room.players.find(player => player.id === room.hostId);
  $('#timeline-events').innerHTML = events.length ? events.map(item => {
    const text = roomHost?.name ? item.text.split(roomHost.name).join('FALCON') : item.text;
    return `<article><span>${icons[item.type] || '•'}</span><div><p>${escapeHtml(text)}</p><time>${new Date(item.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div></article>`;
  }).join('') : '<p class="empty-chat">The match story will appear here.</p>';
}

function renderReactions(room) {
  const unseen = (room.reactions || []).filter(item => !state.seenReactions.has(item.id));
  for (const item of room.reactions || []) state.seenReactions.add(item.id);
  unseen.slice(-8).forEach((item, index) => {
    const bubble = document.createElement('span');
    bubble.textContent = item.emoji;
    bubble.title = item.name;
    bubble.style.setProperty('--reaction-x', `${Math.random() * 150 - 75}px`);
    bubble.style.animationDelay = `${index * 80}ms`;
    $('#reaction-stage').appendChild(bubble);
    setTimeout(() => bubble.remove(), 2000 + index * 80);
  });
}

function renderChat(room) {
  const messages = room.chat || [];
  const newest = messages.at(-1);
  if (state.lastChatId && newest?.id !== state.lastChatId && newest?.playerId !== room.meId) playSound('chat');
  state.lastChatId = newest?.id || null;
  const watching = (room.spectators || []).length;
  $('#chat-members').textContent = `${room.players.length} playing${watching ? ` · ${watching} watching` : ''}`;
  const box = $('#chat-messages');
  box.innerHTML = messages.length ? messages.map(message => {
    const mine = message.playerId === room.meId;
    const admin = message.playerId === room.hostId;
    const displayName = mine ? 'You' : admin ? 'FALCON · ADMIN' : message.name;
    const time = new Date(message.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `<article class="chat-message ${mine ? 'mine' : ''}"><div class="meta"><strong>${escapeHtml(displayName)}</strong><time>${time}</time></div><p>${escapeHtml(message.text)}</p></article>`;
  }).join('') : '<p class="empty-chat">No messages yet. Say hello 👋</p>';
  if (state.chatOpen) {
    state.chatSeen = messages.at(-1)?.id || null;
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }
  const seenIndex = state.chatSeen ? messages.findIndex(message => message.id === state.chatSeen) : -1;
  const unread = state.chatOpen ? 0 : seenIndex >= 0 ? messages.length - seenIndex - 1 : messages.length;
  $('#chat-badge').textContent = unread;
  $('#chat-badge').classList.toggle('hidden', state.chatOpen || unread === 0);
}

function toggleChat(open, restoreFocus = true) {
  if (open && state.timelineOpen) toggleTimeline(false, false);
  state.chatOpen = open;
  $('#chat-panel').classList.toggle('open', open);
  $('#chat-panel').setAttribute('aria-hidden', String(!open));
  $('#chat-panel').toggleAttribute('inert', !open);
  $('#chat-button').setAttribute('aria-expanded', String(open));
  if (open && state.room) {
    state.chatSeen = state.room.chat?.at(-1)?.id || null;
    renderChat(state.room);
    $('#chat-input').focus();
  } else if (!open && restoreFocus) {
    $('#chat-button').focus();
  }
}

function toggleTimeline(open, restoreFocus = true) {
  if (open && state.chatOpen) toggleChat(false, false);
  state.timelineOpen = open;
  $('#timeline-panel').classList.toggle('open', open);
  $('#timeline-panel').setAttribute('aria-hidden', String(!open));
  $('#timeline-panel').toggleAttribute('inert', !open);
  $('#timeline-button').setAttribute('aria-expanded', String(open));
  if (open) $('#close-timeline').focus();
  else if (restoreFocus) $('#timeline-button').focus();
}

function updateTurnTimer() {
  const timer = $('#turn-timer');
  const fill = $('#timer-fill');
  if (!timer || !fill || state.room?.phase !== 'playing') return;
  if (state.room.paused) {
    timer.textContent = 'PAUSED';
    timer.style.color = 'var(--gold)';
    fill.style.width = '0%';
    return;
  }
  if (!state.room.turnDeadline) return;
  const remaining = Math.max(0, state.room.turnDeadline - (Date.now() - serverOffset));
  const seconds = remaining / 1000;
  timer.textContent = `${seconds.toFixed(1)}s`;
  timer.style.color = seconds <= 2.5 ? 'var(--danger)' : 'var(--ink)';
  fill.style.width = `${Math.min(100, (remaining / (state.room.turnDurationMs || 10000)) * 100)}%`;
  fill.style.background = seconds <= 2.5 ? 'var(--danger)' : 'var(--lime)';
}

setInterval(updateTurnTimer, 100);

async function doAction(type, targetId) {
  if (state.acting) return;
  state.acting = true;
  if (type === 'roll' || type === 'risk_die') playSound('roll');
  if (state.room) render(state.room);
  try {
    const { room } = await api(`/api/rooms/${state.code}/action`, {
      method: 'POST', body: JSON.stringify({ playerId: state.playerId, sessionToken: state.sessionToken, type, targetId })
    });
    const animate = type === 'roll' || type === 'risk_die';
    state.room = room;
    state.acting = false;
    render(room, animate);
    if (type === 'roll' || type === 'risk_die') playSound(room.lastOutcome?.busted ? 'bust' : 'safe');
    if (type === 'hold' && room.phase !== 'finished') playSound('bank');
    if (type === 'freeze') playSound('bank');
  } catch (error) {
    state.acting = false;
    $('#game-error').textContent = error.message;
    if (state.room) render(state.room);
  }
}

document.querySelectorAll('.mode-tab').forEach(tab => tab.addEventListener('click', () => setMode(tab.dataset.mode)));
document.querySelectorAll('.role-choice').forEach(button => button.addEventListener('click', () => {
  state.joinRole = button.dataset.role;
  document.querySelectorAll('.role-choice').forEach(choice => {
    const active = choice === button;
    choice.classList.toggle('active', active);
    choice.setAttribute('aria-pressed', String(active));
  });
}));
$('#room-input').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 5); });
$('#rejoin-input').addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6); });

$('#entry-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('#name-input').value.trim();
  const code = $('#room-input').value.trim().toUpperCase();
  const rejoinCode = $('#rejoin-input').value.trim();
  const submit = $('#entry-submit');
  submit.disabled = true;
  $('#entry-error').textContent = '';
  try {
    const data = state.mode === 'create'
      ? await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name, profileToken: state.profileToken }) })
      : await api(`/api/rooms/${code}/join`, { method: 'POST', body: JSON.stringify({ name, role: state.joinRole, rejoinCode, profileToken: state.profileToken }) });
    state.playerId = data.playerId;
    state.sessionToken = data.sessionToken;
    state.rejoinCode = data.rejoinCode;
    enterGame(data.room);
  } catch (error) {
    $('#entry-error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$('#start-button').addEventListener('click', () => doAction('start'));
$('#ready-button').addEventListener('click', () => doAction('ready'));
$('#add-bot-button').addEventListener('click', () => doAction('add_bot', $('#bot-difficulty').value));
$('#mode-picker').addEventListener('click', event => {
  const button = event.target.closest('[data-game-mode]');
  if (button) doAction('set_mode', button.dataset.gameMode);
});
$('#roll-button').addEventListener('click', () => doAction('roll'));
$('#hold-button').addEventListener('click', () => doAction('hold'));
$('#double-button').addEventListener('click', () => doAction('risk_die'));
$('#freeze-button').addEventListener('click', () => {
  const targets = state.room.players.filter(player => player.id !== state.playerId && (state.room.mode.id !== 'battle' || player.score > 0));
  $('#freeze-targets').innerHTML = targets.map(player => `<button data-player-id="${escapeHtml(player.id)}" ${player.frozen ? 'disabled' : ''}>❄ ${escapeHtml(player.id === state.room.hostId ? 'FALCON' : player.name)}${player.frozen ? ' · already frozen' : ''}</button>`).join('');
  $('#freeze-dialog').showModal();
});
$('#freeze-targets').addEventListener('click', async event => {
  const button = event.target.closest('button[data-player-id]');
  if (!button) return;
  $('#freeze-dialog').close();
  await doAction('freeze', button.dataset.playerId);
});
$('#restart-button').addEventListener('click', () => doAction('restart'));
$('#view-results-button').addEventListener('click', openWinnerResults);
$('#close-winner').addEventListener('click', () => $('#winner-dialog').close());
$('#players').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-bot]');
  if (button) doAction('remove_bot', button.dataset.removeBot);
});
document.querySelector('.reaction-bar').addEventListener('click', async event => {
  const button = event.target.closest('[data-reaction]');
  if (!button) return;
  try {
    const { room } = await api(`/api/rooms/${state.code}/reaction`, {
      method: 'POST', body: JSON.stringify({ playerId: state.playerId, sessionToken: state.sessionToken, emoji: button.dataset.reaction })
    });
    state.room = room;
    render(room);
  } catch (error) { showToast(error.message); }
});

$('#copy-button').addEventListener('click', async () => {
  const invite = `${location.origin}/?room=${state.code}`;
  try {
    if (!navigator.clipboard) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(invite);
    showToast('Invite link copied');
  } catch {
    const helper = document.createElement('textarea');
    helper.value = invite;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
    showToast('Invite link copied');
  }
});

$('#session-key').addEventListener('click', async () => {
  if (!state.rejoinCode) return;
  try { await navigator.clipboard.writeText(state.rejoinCode); } catch { /* The key remains visible if clipboard access is blocked. */ }
  showToast('Private rejoin key copied');
});

$('#chat-button').addEventListener('click', () => toggleChat(true));
$('#close-chat').addEventListener('click', () => toggleChat(false));
$('#timeline-button').addEventListener('click', () => {
  toggleTimeline(true);
});
$('#close-timeline').addEventListener('click', () => toggleTimeline(false));
$('#chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('#chat-input');
  const message = input.value.trim();
  if (!message) return;
  input.disabled = true;
  $('#chat-error').textContent = '';
  try {
    const { room } = await api(`/api/rooms/${state.code}/chat`, {
      method: 'POST', body: JSON.stringify({ playerId: state.playerId, sessionToken: state.sessionToken, text: message })
    });
    input.value = '';
    state.room = room;
    render(room);
    playSound('safe');
  } catch (error) {
    $('#chat-error').textContent = error.message;
  } finally {
    input.disabled = false;
    input.focus();
  }
});

let inlineAdminToken = sessionStorage.getItem('dice-night-admin') || '';
const INLINE_ADMIN_TITLES = [
  { value: '', label: 'No featured title' },
  { value: 'triple_champion', label: '×3 Champion' },
  { value: 'founder', label: 'Founder' }
];

async function inlineAdminApi(url, options = {}) {
  return api(url, { ...options, headers: { Authorization: `Bearer ${inlineAdminToken}`, ...(options.headers || {}) } });
}

function inlineAdminProfile(profile) {
  const stats = profile.stats || {};
  const featuredTitleKey = profile.featuredTitleKey || profile.featuredTitle?.key || '';
  return {
    id: String(profile.id || profile.profileId || ''),
    displayName: String(profile.displayName || profile.name || ''),
    xp: Math.max(0, Number(profile.xp || 0)),
    games: Math.max(0, Number(profile.games ?? stats.games ?? 0)),
    wins: Math.max(0, Number(profile.wins ?? stats.wins ?? 0)),
    featuredTitleKey: INLINE_ADMIN_TITLES.some(title => title.value === featuredTitleKey) ? featuredTitleKey : ''
  };
}

function inlineAdminProfileMarkup(rawProfile) {
  const profile = inlineAdminProfile(rawProfile);
  if (!profile.id) return '';
  const titleOptions = INLINE_ADMIN_TITLES.map(title => `<option value="${title.value}" ${title.value === profile.featuredTitleKey ? 'selected' : ''}>${escapeHtml(title.label)}</option>`).join('');
  return `<form class="inline-admin-user" data-admin-profile-form data-profile-id="${escapeHtml(profile.id)}" data-profile-name="${escapeHtml(profile.displayName)}">
    <label class="admin-user-name"><span>Name</span><input name="displayName" maxlength="10" value="${escapeHtml(profile.displayName)}" autocomplete="off" required></label>
    <label><span>XP</span><input name="xp" type="number" min="0" step="1" inputmode="numeric" value="${profile.xp}" required></label>
    <label><span>Games</span><input name="games" type="number" min="0" step="1" inputmode="numeric" value="${profile.games}" required></label>
    <label><span>Wins</span><input name="wins" type="number" min="0" step="1" inputmode="numeric" value="${profile.wins}" required></label>
    <label class="admin-user-title"><span>Featured title</span><select name="featuredTitleKey">${titleOptions}</select></label>
    <div class="admin-user-actions"><button type="submit">Save</button><button type="button" class="danger" data-admin-profile-delete>Remove</button></div>
  </form>`;
}

function renderInlineAdminProfiles(payload) {
  const profiles = (Array.isArray(payload) ? payload : payload?.profiles || []).map(inlineAdminProfile).filter(profile => profile.id);
  $('#inline-profile-total').textContent = profiles.length;
  $('#inline-admin-user-list').innerHTML = profiles.length
    ? profiles.map(inlineAdminProfileMarkup).join('')
    : '<p class="inline-admin-empty">No saved profiles yet.</p>';
  $('#inline-admin-profile-status').textContent = '';
}

function hideInlineAdminContent({ clearToken = false } = {}) {
  $('#inline-admin-content').classList.add('hidden');
  $('#inline-admin-login').classList.remove('hidden');
  $('#inline-admin-user-list').innerHTML = '';
  $('#inline-profile-total').textContent = '0';
  $('#inline-admin-profile-status').textContent = '';
  if (clearToken) {
    inlineAdminToken = '';
    sessionStorage.removeItem('dice-night-admin');
  }
}

function inlineAdminRoom(room) {
  const mainAction = room.phase === 'playing' ? (room.paused ? 'resume' : 'pause') : room.phase === 'finished' ? 'reset' : 'force_start';
  const players = room.players.map(player => `<div class="inline-room-tools"><b>${escapeHtml(player.name)}${player.isBot ? ' · BOT' : ''}</b><span>${player.score} pts</span><button data-score="-5" data-player="${player.id}">-5</button><button data-score="5" data-player="${player.id}">+5</button>${player.id === room.hostId ? '' : `<button class="danger" data-remove="${player.id}">Remove</button>`}</div>`).join('');
  const lobbyTools = room.phase === 'lobby' ? `<select data-inline-mode aria-label="Game type">${['classic','blitz','marathon','showdown','battle'].map(mode => `<option value="${mode}" ${room.mode?.id === mode ? 'selected' : ''}>${mode.replace('showdown', 'five-round showdown').replace('battle', 'battle dice')}</option>`).join('')}</select><select data-admin-bot-style aria-label="Practice bot style"><option value="careful">Careful bot</option><option value="balanced" selected>Balanced bot</option><option value="bold">Bold bot</option></select><button data-admin-action="add_bot">Add bot</button>` : '';
  return `<article class="inline-admin-room" data-admin-room="${room.code}"><header><div><b>${room.code}</b> · ${room.phase}${room.paused ? ' · paused' : ''}</div><span>${room.players.length}/9</span></header>${players}<div class="inline-room-tools"><button data-admin-action="${mainAction}">${mainAction.replace('_', ' ')}</button>${lobbyTools}<select data-admin-timer>${[5,10,15,20,30,45,60].map(value => `<option value="${value}" ${room.turnDurationMs === value * 1000 ? 'selected' : ''}>${value} sec</option>`).join('')}</select><button data-admin-action="clear_chat">Clear chat</button><button data-admin-action="reset">Reset</button><button class="danger" data-admin-action="close">Close room</button></div></article>`;
}

async function refreshInlineAdmin() {
  $('#inline-admin-profile-status').textContent = 'Loading saved users…';
  const [roomData, profileResult, records] = await Promise.all([
    inlineAdminApi('/api/admin/rooms'),
    inlineAdminApi('/api/admin/profiles').then(data => ({ data })).catch(error => ({ error })),
    inlineAdminApi('/api/admin/records?limit=1').catch(() => ({ summary: { matches: 0 } }))
  ]);
  $('#inline-room-total').textContent = roomData.rooms.length;
  $('#inline-player-total').textContent = roomData.rooms.reduce((sum, room) => sum + room.players.length, 0);
  $('#inline-match-total').textContent = records.summary.matches || 0;
  $('#inline-admin-rooms').innerHTML = roomData.rooms.length ? roomData.rooms.map(inlineAdminRoom).join('') : '<p>No active rooms.</p>';
  if (profileResult.error) {
    $('#inline-profile-total').textContent = '—';
    $('#inline-admin-user-list').innerHTML = '<p class="inline-admin-empty">The saved user list is unavailable.</p>';
    $('#inline-admin-profile-status').textContent = profileResult.error.message;
  } else {
    renderInlineAdminProfiles(profileResult.data);
  }
  $('#inline-admin-login').classList.add('hidden');
  $('#inline-admin-content').classList.remove('hidden');
  $('#inline-admin-error').textContent = '';
}

async function inlineAdminAction(code, type, extra = {}) {
  await inlineAdminApi(`/api/admin/rooms/${code}`, { method: 'POST', body: JSON.stringify({ type, ...extra }) });
  await refreshInlineAdmin();
}

$('#admin-deck-button').addEventListener('click', async () => {
  $('#admin-deck-dialog').showModal();
  if (inlineAdminToken) {
    try { await refreshInlineAdmin(); } catch { hideInlineAdminContent({ clearToken: true }); }
  } else {
    hideInlineAdminContent();
  }
});
$('#close-admin-deck').addEventListener('click', () => $('#admin-deck-dialog').close());
$('#inline-admin-login').addEventListener('submit', async event => {
  event.preventDefault();
  inlineAdminToken = $('#inline-admin-token').value.trim();
  try {
    await refreshInlineAdmin();
    sessionStorage.setItem('dice-night-admin', inlineAdminToken);
  } catch (error) {
    hideInlineAdminContent({ clearToken: true });
    $('#inline-admin-error').textContent = 'That admin key did not work.';
  }
});
$('#inline-admin-refresh').addEventListener('click', () => refreshInlineAdmin().catch(error => { $('#inline-admin-error').textContent = error.message; }));
$('#inline-reset-leaderboard').addEventListener('click', async () => {
  if (!confirm('Reset every leaderboard score and saved match record? Player logins will stay active.')) return;
  try {
    await inlineAdminApi('/api/admin/leaderboard/reset', { method: 'POST', body: '{}' });
    await refreshInlineAdmin();
    showToast('Leaderboard and match records reset');
  } catch (error) { $('#inline-admin-error').textContent = error.message; }
});
$('#inline-admin-lock').addEventListener('click', () => {
  hideInlineAdminContent({ clearToken: true });
});

$('#inline-admin-user-list').addEventListener('submit', async event => {
  const form = event.target.closest('[data-admin-profile-form]');
  if (!form) return;
  event.preventDefault();
  const displayName = form.elements.displayName.value.trim();
  const xp = Number(form.elements.xp.value);
  const games = Number(form.elements.games.value);
  const wins = Number(form.elements.wins.value);
  if (!displayName || displayName.length > 10) {
    $('#inline-admin-profile-status').textContent = 'Names must be 1 to 10 characters.';
    form.elements.displayName.focus();
    return;
  }
  if (![xp, games, wins].every(value => Number.isInteger(value) && value >= 0)) {
    $('#inline-admin-profile-status').textContent = 'XP, games, and wins must be whole numbers at least 0.';
    return;
  }
  if (wins > games) {
    $('#inline-admin-profile-status').textContent = 'Wins cannot be higher than games played.';
    form.elements.wins.focus();
    return;
  }
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  $('#inline-admin-profile-status').textContent = `Saving ${displayName}…`;
  try {
    await inlineAdminApi(`/api/admin/profiles/${encodeURIComponent(form.dataset.profileId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName, xp, games, wins, featuredTitle: form.elements.featuredTitleKey.value || null })
    });
    await refreshInlineAdmin();
    showToast(`${displayName} was updated`);
  } catch (error) {
    submit.disabled = false;
    $('#inline-admin-profile-status').textContent = error.message;
  }
});

$('#inline-admin-user-list').addEventListener('click', async event => {
  const removeButton = event.target.closest('[data-admin-profile-delete]');
  if (!removeButton) return;
  const form = removeButton.closest('[data-admin-profile-form]');
  const displayName = form.dataset.profileName || 'this user';
  if (!confirm(`Permanently remove ${displayName}? Their profile login, title, and achievements will be deleted. This cannot be undone.`)) return;
  removeButton.disabled = true;
  $('#inline-admin-profile-status').textContent = `Removing ${displayName}…`;
  try {
    await inlineAdminApi(`/api/admin/profiles/${encodeURIComponent(form.dataset.profileId)}`, { method: 'DELETE' });
    await refreshInlineAdmin();
    showToast(`${displayName} was permanently removed`);
  } catch (error) {
    removeButton.disabled = false;
    $('#inline-admin-profile-status').textContent = error.message;
  }
});
$('#inline-admin-rooms').addEventListener('click', async event => {
  const room = event.target.closest('[data-admin-room]');
  if (!room) return;
  const type = event.target.dataset.adminAction;
  const playerId = event.target.dataset.player;
  const removeId = event.target.dataset.remove;
  try {
    if (type) {
      if ((type === 'reset' || type === 'close') && !confirm(`${type} room ${room.dataset.adminRoom}?`)) return;
      const extra = type === 'add_bot' ? { style: room.querySelector('[data-admin-bot-style]').value } : {};
      await inlineAdminAction(room.dataset.adminRoom, type, extra);
    } else if (playerId) {
      await inlineAdminAction(room.dataset.adminRoom, 'score', { playerId, delta: Number(event.target.dataset.score) });
    } else if (removeId && confirm('Remove this player?')) {
      await inlineAdminAction(room.dataset.adminRoom, 'remove_player', { playerId: removeId });
    }
  } catch (error) { showToast(error.message); }
});
$('#inline-admin-rooms').addEventListener('change', event => {
  const room = event.target.closest('[data-admin-room]');
  if (event.target.matches('[data-admin-timer]')) {
    inlineAdminAction(room.dataset.adminRoom, 'set_timer', { seconds: Number(event.target.value) }).catch(error => showToast(error.message));
  } else if (event.target.matches('[data-inline-mode]')) {
    inlineAdminAction(room.dataset.adminRoom, 'set_mode', { mode: event.target.value }).catch(error => showToast(error.message));
  }
});

$('#profile-button').addEventListener('click', () => $('#profile-dialog').showModal());
$('#close-profile').addEventListener('click', () => $('#profile-dialog').close());
$('#sound-toggle').addEventListener('click', () => setSoundEnabled(!state.soundEnabled));
$('#leaderboard-button').addEventListener('click', () => {
  $('#leaderboard-dialog').showModal();
  loadLeaderboard();
});
$('#close-leaderboard').addEventListener('click', () => $('#leaderboard-dialog').close());
$('#leaderboard-filters').addEventListener('click', event => {
  const button = event.target.closest('[data-sort], [data-leaderboard-sort]');
  if (!button) return;
  state.leaderboardSort = button.dataset.leaderboardSort || button.dataset.sort;
  document.querySelectorAll('[data-leaderboard-sort]').forEach(option => {
    const active = option === button;
    option.classList.toggle('active', active);
    option.setAttribute('aria-pressed', String(active));
  });
  loadLeaderboard();
});
for (const id of ['profile-pin', 'login-pin']) {
  $(`#${id}`).addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6); });
}
$('#profile-code').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 8); });
$('#create-profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#profile-error').textContent = '';
  try {
    acceptProfile(await api('/api/profiles', { method: 'POST', body: JSON.stringify({ displayName: $('#profile-name').value, pin: $('#profile-pin').value }) }));
  } catch (error) { $('#profile-error').textContent = error.message; }
});
$('#login-profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#profile-error').textContent = '';
  try {
    acceptProfile(await api('/api/profiles/login', { method: 'POST', body: JSON.stringify({ code: $('#profile-code').value, pin: $('#login-pin').value }) }));
  } catch (error) { $('#profile-error').textContent = error.message; }
});
$('#profile-logout').addEventListener('click', () => {
  state.profileToken = null;
  state.profile = null;
  localStorage.removeItem('dice-night:profile-token');
  renderProfile();
});

$('#how-button').addEventListener('click', () => $('#rules-dialog').showModal());
$('#close-rules').addEventListener('click', () => $('#rules-dialog').close());
$('#updates-button').addEventListener('click', () => $('#updates-dialog').showModal());
$('#close-updates').addEventListener('click', () => $('#updates-dialog').close());
$('#close-freeze').addEventListener('click', () => $('#freeze-dialog').close());
$('#rules-dialog').addEventListener('click', event => {
  const rect = event.currentTarget.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
});

$('#updates-dialog').addEventListener('click', event => {
  const rect = event.currentTarget.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
});

function dismissRoyaleIntro() {
  const intro = $('#royale-intro');
  intro.classList.add('leaving');
  setIntroInert(false);
  $('#name-input').focus();
  intro.setAttribute('aria-hidden', 'true');
  try { sessionStorage.setItem('dice-night:intro-v31', 'seen'); } catch { /* Session storage is optional. */ }
  playSound('bank');
}

function setIntroInert(active) {
  document.querySelectorAll('body > header, body > main').forEach(element => element.toggleAttribute('inert', active));
}

let introVisible = true;
try {
  if (sessionStorage.getItem('dice-night:intro-v31') === 'seen') {
    $('#royale-intro').classList.add('leaving');
    $('#royale-intro').setAttribute('aria-hidden', 'true');
    introVisible = false;
  }
} catch { /* Show the intro when session storage is unavailable. */ }
setIntroInert(introVisible);
if (introVisible) requestAnimationFrame(() => $('#enter-royale').focus());

$('#enter-royale').addEventListener('click', dismissRoyaleIntro);
$('#intro-updates').addEventListener('click', () => {
  dismissRoyaleIntro();
  $('#updates-dialog').showModal();
});

$('#royale-intro').addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    dismissRoyaleIntro();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [$('#enter-royale'), $('#intro-updates')];
  const current = focusable.indexOf(document.activeElement);
  const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current + 1) % focusable.length;
  event.preventDefault();
  focusable[next].focus();
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (state.chatOpen) toggleChat(false);
  if (state.timelineOpen) toggleTimeline(false);
});

updateSoundControl();
loadProfile();

(async function restoreOrPrefill() {
  const code = new URLSearchParams(location.search).get('room')?.toUpperCase();
  if (!code) return;
  const savedValue = localStorage.getItem(`dice-night:${code}`);
  if (savedValue) {
    try {
      const savedSession = JSON.parse(savedValue);
      state.code = code;
      state.playerId = savedSession.playerId;
      state.sessionToken = savedSession.sessionToken;
      state.rejoinCode = savedSession.rejoinCode;
      const { room } = await api(`/api/rooms/${code}?playerId=${encodeURIComponent(state.playerId)}`, { headers: { Authorization: `Bearer ${state.sessionToken}` } });
      enterGame(room);
      return;
    } catch {
      localStorage.removeItem(`dice-night:${code}`);
    }
  }
  setMode('join');
  $('#room-input').value = code;
  $('#name-input').focus();
})();
