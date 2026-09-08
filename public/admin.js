const $ = selector => document.querySelector(selector);
let token = sessionStorage.getItem('dice-night-admin') || '';
let timer;
let recordsTimer;

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Admin request failed.');
  return data;
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  setTimeout(() => $('#toast').classList.remove('show'), 1700);
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown time';
}

async function refreshRecords() {
  try {
    const records = await api('/api/admin/records?limit=12');
    $('#match-total').textContent = records.summary.matches || 0;
    $('#record-player-total').textContent = records.summary.players || 0;
    $('#roll-total').textContent = records.summary.rolls || 0;
    $('#bust-total').textContent = records.summary.busts || 0;
    $('#export-records').disabled = !records.configured;
    $('#records-status').textContent = records.configured
      ? 'PostgreSQL is connected. These records survive server restarts.'
      : 'Local JSON mode is active. Add DATABASE_URL when deploying to enable permanent records.';
    $('#recent-records').innerHTML = records.recent.length
      ? records.recent.map(match => `<div class="record-row"><span><strong>${escapeHtml(match.winner_name || 'No winner')}</strong> · ${escapeHtml(match.mode)} · ${escapeHtml(match.room_code)}</span><small>${match.winner_score ?? 0} pts · ${escapeHtml(formatDate(match.ended_at))}</small></div>`).join('')
      : '<p>No completed matches recorded yet.</p>';
    $('#record-leaderboard').innerHTML = records.leaderboard.length
      ? records.leaderboard.map((player, index) => `<div class="record-row"><span><strong>#${index + 1} ${escapeHtml(player.player_name)}</strong></span><small>${player.wins} wins · ${player.games_played} games</small></div>`).join('')
      : '<p>Leaderboard appears after the first recorded match.</p>';
  } catch {
    $('#records-status').textContent = 'Records will activate after the PostgreSQL server update is deployed.';
    $('#export-records').disabled = true;
  }
}

async function downloadRecords() {
  const response = await fetch('/api/admin/records.csv?limit=20000', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Could not export records.');
  }
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'dice-night-match-records.csv';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function roomCard(room) {
  const controls = room.phase === 'lobby'
    ? `<button data-action="force_start">Force start</button>`
    : room.phase === 'playing'
      ? `<button data-action="${room.paused ? 'resume' : 'pause'}">${room.paused ? '▶ Resume' : '⏸ Pause'}</button>`
      : `<button data-action="reset">New match</button>`;
  const players = room.players.map(player => `<article class="player ${player.id === room.hostId ? 'admin' : ''}">
    <div class="player-name">${escapeHtml(player.name)}${player.frozen ? ' ❄' : ''}${room.phase === 'lobby' ? player.ready ? ' ✓' : ' · waiting' : ''}<small>${player.stats?.rolls || 0} rolls · ${player.stats?.busts || 0} busts · ${player.career?.wins || 0} room wins</small></div>
    <div class="score-tools"><button data-score="-5" data-player="${player.id}">−</button><strong>${player.score}</strong><button data-score="5" data-player="${player.id}">+</button>${player.id === room.hostId ? '' : `<button class="remove" data-remove="${player.id}" title="Remove player">×</button>`}</div>
  </article>`).join('');
  const spectators = (room.spectators || []).map(person => `<button class="spectator-admin" data-remove-spectator="${person.id}" title="Remove spectator">◉ ${escapeHtml(person.name)} ×</button>`).join('');
  return `<article class="room-card" data-room="${room.code}">
    <div class="room-head"><div class="room-title"><strong class="room-code">${room.code}</strong><span class="phase ${room.paused ? 'paused' : ''}">${room.paused ? 'paused' : room.phase}</span><small>${room.players.length}/9 players</small></div>
      <div class="room-tools">${controls}<select data-mode ${room.phase !== 'lobby' ? 'disabled' : ''}>${['classic','blitz','marathon'].map(mode => `<option value="${mode}" ${room.mode?.id === mode ? 'selected' : ''}>${mode}</option>`).join('')}</select><select data-timer><option disabled>Turn time</option>${[5,7,10,15,20,30,45,60].map(seconds => `<option value="${seconds}" ${room.turnDurationMs === seconds * 1000 ? 'selected' : ''}>${seconds} sec</option>`).join('')}</select><button data-action="clear_chat">Clear chat</button><button data-action="reset">Reset</button><button class="danger" data-action="close">Close room</button></div></div>
    <div class="room-body"><div class="players">${players}<div>${spectators}</div></div><aside class="broadcast"><label>ANNOUNCE TO ROOM</label><form data-announce><input maxlength="120" placeholder="Message every player…"><button>Send</button></form><p>Latest: ${escapeHtml(room.message)}</p></aside></div>
  </article>`;
}

async function refresh() {
  try {
    const { rooms } = await api('/api/admin/rooms');
    $('#connection').innerHTML = '<i></i> Live';
    $('#room-total').textContent = rooms.length;
    $('#player-total').textContent = rooms.reduce((sum, room) => sum + room.players.length, 0);
    $('#playing-total').textContent = rooms.filter(room => room.phase === 'playing').length;
    $('#rooms').innerHTML = rooms.length ? rooms.map(roomCard).join('') : '<div class="empty">No active rooms yet.</div>';
    $('#panel-error').textContent = '';
    return true;
  } catch (error) {
    $('#connection').textContent = 'Offline';
    $('#panel-error').textContent = error.message;
    return false;
  }
}

async function sendAction(code, type, extra = {}) {
  const data = await api(`/api/admin/rooms/${code}`, { method: 'POST', body: JSON.stringify({ type, ...extra }) });
  toast(data.closed ? `Room ${code} closed` : 'Control applied');
  await refresh();
}

$('#rooms').addEventListener('click', async event => {
  const card = event.target.closest('[data-room]');
  if (!card) return;
  const code = card.dataset.room;
  try {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const playerId = event.target.closest('[data-player]')?.dataset.player;
    const removeId = event.target.closest('[data-remove]')?.dataset.remove;
    const removeSpectatorId = event.target.closest('[data-remove-spectator]')?.dataset.removeSpectator;
    if (action) {
      if (['reset', 'close'].includes(action) && !confirm(`${action === 'close' ? 'Permanently close' : 'Reset'} room ${code}?`)) return;
      await sendAction(code, action);
    } else if (playerId) {
      await sendAction(code, 'score', { playerId, delta: Number(event.target.dataset.score) });
    } else if (removeId && confirm('Remove this player from the room?')) {
      await sendAction(code, 'remove_player', { playerId: removeId });
    } else if (removeSpectatorId && confirm('Remove this spectator from the room?')) {
      await sendAction(code, 'remove_spectator', { playerId: removeSpectatorId });
    }
  } catch (error) { toast(error.message); }
});

$('#rooms').addEventListener('change', async event => {
  const code = event.target.closest('[data-room]').dataset.room;
  try {
    if (event.target.matches('[data-timer]')) await sendAction(code, 'set_timer', { seconds: Number(event.target.value) });
    if (event.target.matches('[data-mode]')) await sendAction(code, 'set_mode', { mode: event.target.value });
  } catch (error) { toast(error.message); }
});

$('#rooms').addEventListener('submit', async event => {
  const form = event.target.closest('[data-announce]');
  if (!form) return;
  event.preventDefault();
  const code = form.closest('[data-room]').dataset.room;
  const input = form.querySelector('input');
  try { await sendAction(code, 'announce', { text: input.value }); } catch (error) { toast(error.message); }
});

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  token = $('#token-input').value.trim();
  if (await refresh()) {
    sessionStorage.setItem('dice-night-admin', token);
    $('#login-dialog').close();
    clearInterval(timer);
    clearInterval(recordsTimer);
    timer = setInterval(refresh, 2500);
    await refreshRecords();
    recordsTimer = setInterval(refreshRecords, 15000);
  } else {
    $('#login-error').textContent = 'That key did not work.';
  }
});

$('#refresh-button').addEventListener('click', async () => {
  await Promise.all([refresh(), refreshRecords()]);
});
$('#export-records').addEventListener('click', async () => {
  try { await downloadRecords(); } catch (error) { toast(error.message); }
});
$('#lock-button').addEventListener('click', () => {
  sessionStorage.removeItem('dice-night-admin');
  token = '';
  clearInterval(timer);
  clearInterval(recordsTimer);
  $('#token-input').value = '';
  $('#login-dialog').showModal();
});

(async function start() {
  if (token && await refresh()) {
    timer = setInterval(refresh, 2500);
    await refreshRecords();
    recordsTimer = setInterval(refreshRecords, 15000);
  }
  else $('#login-dialog').showModal();
})();
