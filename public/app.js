const $ = selector => document.querySelector(selector);
const state = { mode: 'create', joinRole: 'player', code: null, playerId: null, sessionToken: null, rejoinCode: null, room: null, polling: null, acting: false, chatOpen: false, timelineOpen: false, chatSeen: null, celebratedWinner: null, seenReactions: new Set() };
let audioContext;
let serverOffset = 0;

const screens = { home: $('#home-screen'), game: $('#game-screen') };
const pipMap = {
  1: ['mc'], 2: ['tl', 'br'], 3: ['tl', 'mc', 'br'],
  4: ['tl', 'tr', 'bl', 'br'], 5: ['tl', 'tr', 'mc', 'bl', 'br'],
  6: ['tl', 'tr', 'ml', 'mr', 'bl', 'br']
};

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.mode === mode));
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

function saveSession() {
  localStorage.setItem(`dice-night:${state.code}`, JSON.stringify({ playerId: state.playerId, sessionToken: state.sessionToken, rejoinCode: state.rejoinCode }));
  history.replaceState(null, '', `/?room=${state.code}`);
}

function playSound(kind) {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const now = audioContext.currentTime;
    const notes = {
      roll: [[180, .03, .05], [240, .09, .05], [320, .15, .07]],
      safe: [[440, 0, .08], [620, .08, .1]],
      bust: [[150, 0, .22], [90, .12, .32]],
      bank: [[520, 0, .08], [720, .08, .08], [900, .16, .12]],
      win: [[523, 0, .18], [659, .18, .18], [784, .36, .3], [659, .72, .16], [784, .9, .16], [1047, 1.08, .48], [784, 1.62, .16], [880, 1.8, .16], [988, 1.98, .2], [1047, 2.22, .7], [523, 2.22, .7], [659, 2.22, .7]]
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
      oscillator.start(now + delay);
      oscillator.stop(now + delay + duration + .02);
    }
  } catch { /* Sound is an enhancement; the game still works if audio is blocked. */ }
}

function celebrate(winnerId) {
  const celebrationId = `${state.room?.matchId || 0}:${winnerId}`;
  if (!winnerId || state.celebratedWinner === celebrationId) return;
  state.celebratedWinner = celebrationId;
  playSound('win');
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

async function poll() {
  if (!state.code || !state.playerId || state.acting) return;
  try {
    const { room } = await api(`/api/rooms/${state.code}?playerId=${encodeURIComponent(state.playerId)}&sessionToken=${encodeURIComponent(state.sessionToken)}`);
    if (!state.room || room.version !== state.room.version) {
      const oldMessage = state.room?.message;
      const rolled = oldMessage !== room.message && room.message.includes('rolled');
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
  return `<article class="player-card ${active ? 'active' : ''} ${winner ? 'winner' : ''} ${admin ? 'admin' : ''} ${player.ready ? 'ready' : ''}">
    <div class="player-top"><span class="avatar">${admin ? '♛' : escapeHtml(player.name[0].toUpperCase())}</span><span class="player-name">${escapeHtml(displayName)}</span>${admin ? '<span class="admin-badge">ADMIN</span>' : ''}${player.id === room.meId ? '<span class="you">YOU</span>' : ''}<span class="player-perks" title="${player.frozen ? 'Next turn frozen' : player.shieldAvailable ? 'Safety Net available' : ''}">${player.frozen ? '❄' : player.shieldAvailable ? '◈' : ''}</span></div>
    <div class="player-score"><strong>${player.score}</strong><span>${room.phase === 'lobby' ? player.ready ? 'READY' : 'WAITING' : 'PTS'}</span></div>
  </article>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function displayName(person, room = state.room) {
  return person?.id === room?.hostId ? 'FALCON' : person?.name || 'Unknown player';
}

function renderDice(value, animate = false) {
  const dice = $('#dice');
  const shown = value || 1;
  dice.innerHTML = pipMap[shown].map(position => `<span class="pip ${position}"></span>`).join('');
  dice.setAttribute('aria-label', value ? `Rolled ${value}` : 'Ready to roll');
  dice.style.opacity = value ? '1' : '.45';
  if (animate) {
    dice.classList.remove('rolling');
    void dice.offsetWidth;
    dice.classList.add('rolling');
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
  $('#last-action-die').textContent = room.lastRoll ? `🎲 ${room.lastRoll}` : room.phase === 'lobby' ? 'READY' : 'PLAY';
  $('#game-error').textContent = '';
  renderChat(room);
  renderTimeline(room);
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

  if (room.phase === 'lobby') {
    const count = room.players.length;
    $('#lobby-count').textContent = `${count} of ${room.maxPlayers} seats filled`;
    const host = room.hostId === room.meId;
    const me = room.players.find(player => player.id === room.meId);
    document.querySelectorAll('[data-game-mode]').forEach(button => {
      button.classList.toggle('active', button.dataset.gameMode === room.mode.id);
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
  }

  if (room.phase === 'playing') {
    const current = room.players[room.turnIndex];
    const myTurn = current.id === room.meId;
    document.querySelector('.game-actions').classList.toggle('spectating', room.meRole === 'spectator');
    const currentName = displayName(current, room).toUpperCase();
    $('#turn-label').textContent = room.paused ? 'TABLE PAUSED' : myTurn ? 'YOUR TURN' : room.meRole === 'spectator' ? `WATCHING ${currentName}` : `${currentName}'S TURN`;
    $('#turn-score').textContent = room.turnScore;
    $('#risk-percent').textContent = `${room.risk?.percent ?? 16}%`;
    $('#risk-fill').style.width = `${room.risk?.percent ?? 16}%`;
    $('#risk-penalty').textContent = `Roll 1 penalty: −${room.risk?.penalty ?? 5} points`;
    $('#streak-progress').textContent = room.nextBonusIn === 1 ? 'Next safe roll earns +10' : `${room.nextBonusIn ?? 3} rolls to +10 bonus`;
    $('#roll-button').disabled = room.paused || !myTurn || state.acting;
    $('#hold-button').disabled = room.paused || !myTurn || room.turnScore < 1 || state.acting;
    $('#double-risk').textContent = `${room.doubleRisk ?? Math.min(75, (room.risk?.percent ?? 16) + 15)}% bust risk`;
    $('#double-button').disabled = room.paused || !myTurn || room.turnScore < 10 || room.doubleUsed || state.acting;
    const me = room.players.find(player => player.id === room.meId);
    $('#freeze-button').disabled = room.paused || !myTurn || !me || me.score < 5 || room.freezeUsed || room.players.length < 2 || state.acting;
    renderDice(room.lastRoll, animateRoll);
  }

  if (room.phase === 'finished') {
    const winner = room.players.find(player => player.id === room.winnerId);
    if (!winner) {
      $('#winner-name').textContent = 'Winner left the room';
      $('#winner-score').textContent = 'FALCON can begin a fresh match.';
      $('#winner-stats').textContent = '';
      $('#awards').innerHTML = '';
      $('#room-records').innerHTML = '';
      return;
    }
    const winnerName = winner.id === room.hostId ? 'FALCON' : winner.name;
    $('#winner-name').textContent = winner.id === room.meId ? 'You won!' : `${winnerName} wins!`;
    $('#winner-score').textContent = `${winner.score} points — what a run.`;
    const stats = winner.stats || { rolls: 0, busts: 0, bestBank: 0 };
    $('#winner-stats').textContent = `${stats.rolls} rolls · ${stats.busts} busts · ${stats.bestBank} biggest bank`;
    $('#awards').innerHTML = (room.awards || []).map(award => {
      const owner = room.players.find(player => player.id === award.playerId);
      return `<article><span>${award.icon}</span><div><b>${escapeHtml(award.title)}</b><strong>${escapeHtml(owner?.id === room.hostId ? 'FALCON' : owner?.name || '')}</strong><small>${escapeHtml(award.value)}</small></div></article>`;
    }).join('');
    $('#room-records').innerHTML = `<h3>Room records</h3>${[...room.players].sort((a, b) => (b.career?.wins || 0) - (a.career?.wins || 0)).map(player => `<p><b>${escapeHtml(player.id === room.hostId ? 'FALCON' : player.name)}</b><span>${player.career?.wins || 0} wins · ${player.career?.games || 0} games · ${player.career?.totalBanked || 0} banked</span></p>`).join('')}`;
    $('#restart-button').classList.toggle('hidden', room.hostId !== room.meId);
    celebrate(room.winnerId);
  }
}

function renderTimeline(room) {
  const icons = { roll: '🎲', double: '×2', hot_streak: '🔥', bank: '💰', bust: '💥', freeze: '❄', timeout: '⏱', win: '🏆', start: '▶', ready: '✓', mode: '◆', player_join: '+', spectator_join: '◉', lobby: '↻', admin: '♛' };
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

function toggleChat(open) {
  state.chatOpen = open;
  $('#chat-panel').classList.toggle('open', open);
  $('#chat-panel').setAttribute('aria-hidden', String(!open));
  if (open && state.room) {
    state.chatSeen = state.room.chat?.at(-1)?.id || null;
    renderChat(state.room);
    $('#chat-input').focus();
  }
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
  if (type === 'roll' || type === 'double') playSound('roll');
  if (state.room) render(state.room);
  try {
    const { room } = await api(`/api/rooms/${state.code}/action`, {
      method: 'POST', body: JSON.stringify({ playerId: state.playerId, sessionToken: state.sessionToken, type, targetId })
    });
    const animate = type === 'roll' || type === 'double';
    state.room = room;
    state.acting = false;
    render(room, animate);
    if (type === 'roll' || type === 'double') playSound(room.lastRoll === 1 ? 'bust' : 'safe');
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
  document.querySelectorAll('.role-choice').forEach(choice => choice.classList.toggle('active', choice === button));
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
      ? await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) })
      : await api(`/api/rooms/${code}/join`, { method: 'POST', body: JSON.stringify({ name, role: state.joinRole, rejoinCode }) });
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
$('#mode-picker').addEventListener('click', event => {
  const button = event.target.closest('[data-game-mode]');
  if (button) doAction('set_mode', button.dataset.gameMode);
});
$('#roll-button').addEventListener('click', () => doAction('roll'));
$('#hold-button').addEventListener('click', () => doAction('hold'));
$('#double-button').addEventListener('click', () => doAction('double'));
$('#freeze-button').addEventListener('click', () => {
  const targets = state.room.players.filter(player => player.id !== state.playerId);
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
  state.timelineOpen = true;
  $('#timeline-panel').classList.add('open');
  $('#timeline-panel').setAttribute('aria-hidden', 'false');
});
$('#close-timeline').addEventListener('click', () => {
  state.timelineOpen = false;
  $('#timeline-panel').classList.remove('open');
  $('#timeline-panel').setAttribute('aria-hidden', 'true');
});
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
  $('#royale-intro').classList.add('leaving');
  try { sessionStorage.setItem('dice-night:intro-v3', 'seen'); } catch { /* Session storage is optional. */ }
  playSound('bank');
}

try {
  if (sessionStorage.getItem('dice-night:intro-v3') === 'seen') $('#royale-intro').classList.add('leaving');
} catch { /* Show the intro when session storage is unavailable. */ }

$('#enter-royale').addEventListener('click', dismissRoyaleIntro);
$('#intro-updates').addEventListener('click', () => {
  dismissRoyaleIntro();
  $('#updates-dialog').showModal();
});

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
      const { room } = await api(`/api/rooms/${code}?playerId=${encodeURIComponent(state.playerId)}&sessionToken=${encodeURIComponent(state.sessionToken)}`);
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
