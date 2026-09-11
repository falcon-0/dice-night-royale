const $ = selector => document.querySelector(selector);
let token = sessionStorage.getItem('dice-night-admin') || '';
let liveTimer;
let recordsTimer;
let profiles = [];
let plans = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  } catch {
    throw new Error('Cannot reach the game server. Open the latest link from FALCON.');
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw new Error('The game server returned an invalid response. Refresh the latest game link.');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Admin request failed.');
  return data;
}

function toast(message, danger = false) {
  $('#toast').textContent = message;
  $('#toast').classList.toggle('danger', danger);
  $('#toast').classList.add('show');
  setTimeout(() => $('#toast').classList.remove('show'), 2200);
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Not set';
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) { amount /= 1024; unit = units[index]; }
  return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function formatDuration(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function meterRows(items, emptyMessage = 'No traffic yet.') {
  const entries = Object.entries(items || {}).sort((a, b) => b[1] - a[1]);
  const maximum = Math.max(1, ...entries.map(([, value]) => value));
  return entries.length ? entries.map(([label, value]) => `<div class="data-row"><span>${escapeHtml(label)}</span><div><i style="width:${Math.round(value / maximum * 100)}%"></i></div><strong>${Number(value).toLocaleString()}</strong></div>`).join('') : `<p class="analytics-empty">${escapeHtml(emptyMessage)}</p>`;
}

async function refreshAnalytics() {
  const data = await api('/api/admin/analytics');
  const traffic = data.traffic || {};
  const today = traffic.today || {};
  $('#live-total').textContent = traffic.liveVisitors || 0;
  $('#traffic-live').textContent = traffic.liveVisitors || 0;
  $('#traffic-visitors').textContent = today.visitors || 0;
  $('#traffic-views').textContent = today.views || 0;
  $('#traffic-all-visitors').textContent = traffic.allTime?.visitors || 0;
  $('#traffic-all-views').textContent = traffic.allTime?.views || 0;
  $('#analytics-updated').textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

  const trend = traffic.trend || [];
  const chartMax = Math.max(1, ...trend.map(day => Math.max(day.views, day.visitors)));
  $('#traffic-chart').innerHTML = trend.map(day => `<div class="chart-day" title="${day.visitors} visitors · ${day.views} views"><div class="chart-bars"><i class="visitor-bar" style="height:${Math.max(day.visitors ? 8 : 0, day.visitors / chartMax * 100)}%"></i><i class="view-bar" style="height:${Math.max(day.views ? 8 : 0, day.views / chartMax * 100)}%"></i></div><strong>${day.visitors}</strong><span>${new Date(`${day.date}T12:00:00`).toLocaleDateString([], { weekday: 'short' })}</span></div>`).join('');
  $('#device-mix').innerHTML = meterRows(today.devices, 'Device mix appears after the first visit.');
  $('#top-pages').innerHTML = meterRows(today.pages, 'Page views appear here.');

  const activityNames = { room_create: 'Rooms made', room_join: 'Joins', room_rejoin: 'Rejoins', profile_create: 'New profiles', profile_login: 'Logins', subscription_request: 'Plan requests', roll: 'Normal rolls', risk_die: 'Risk rolls', bank: 'Banks', freeze: 'Freezes', chat: 'Chat messages', reaction: 'Reactions' };
  $('#activity-events').innerHTML = Object.entries(data.activity?.today || {}).map(([key, value]) => `<div><small>${escapeHtml(activityNames[key] || key)}</small><strong>${Number(value).toLocaleString()}</strong></div>`).join('');

  const server = data.server || {};
  const game = data.game || {};
  const systemUsed = Math.max(0, (server.systemMemory?.total || 0) - (server.systemMemory?.free || 0));
  $('#server-health').innerHTML = [
    ['Uptime', formatDuration(server.uptimeSeconds)],
    ['Process RAM', formatBytes(server.processMemory?.rss)],
    ['Heap used', `${formatBytes(server.processMemory?.heapUsed)} / ${formatBytes(server.processMemory?.heapTotal)}`],
    ['System RAM', `${formatBytes(systemUsed)} / ${formatBytes(server.systemMemory?.total)}`],
    ['Requests', Number(server.requestsSinceStart || 0).toLocaleString()],
    ['Errors', Number(server.errorsSinceStart || 0).toLocaleString()],
    ['CPU cores', server.cpuCores || '—'],
    ['Node', server.node || '—'],
    ['Live rooms', `${game.playingRooms || 0} playing / ${game.rooms || 0} open`],
    ['Audience', `${game.seatedPlayers || 0} seated · ${game.spectators || 0} watching`],
    ['Profiles', Number(game.profiles || 0).toLocaleString()],
    ['Matches', Number(game.completedMatches || 0).toLocaleString()]
  ].map(([label, value]) => `<div><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`).join('');
}

function dateInputValue(value) {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function paymentCard(request) {
  const pending = request.status === 'pending';
  return `<article class="payment-card ${escapeHtml(request.status)}" data-request="${escapeHtml(request.id)}">
    <div class="payment-main"><span class="request-status">${escapeHtml(request.status)}</span><h3>${escapeHtml(request.profileName)}</h3><p><b>${escapeHtml(request.planName)}</b> · ₦${Number(request.amount).toLocaleString()}</p></div>
    <dl><div><dt>PAYER</dt><dd>${escapeHtml(request.payerName)}</dd></div><div><dt>REFERENCE</dt><dd>${escapeHtml(request.reference)}</dd></div><div><dt>SENT</dt><dd>${escapeHtml(formatDate(request.submittedAt))}</dd></div></dl>
    ${pending ? '<div class="payment-actions"><button data-payment="approved">Approve & activate</button><button class="reject" data-payment="rejected">Reject</button></div>' : `<small>Reviewed ${escapeHtml(formatDate(request.reviewedAt))}</small>`}
  </article>`;
}

function planOptions(selected = 'none') {
  return [`<option value="none" ${selected === 'none' ? 'selected' : ''}>No plan</option>`, ...plans.map(plan => `<option value="${escapeHtml(plan.id)}" ${selected === plan.id ? 'selected' : ''}>${escapeHtml(plan.name)} · ₦${plan.price}</option>`)].join('');
}

function profileRow(profile) {
  const subscription = profile.subscription;
  return `<tr data-profile="${escapeHtml(profile.id)}">
    <td><strong>${escapeHtml(profile.displayName)}</strong><small>Level ${profile.level} · ${profile.achievementCount} badges</small></td>
    <td><b>${profile.wins}</b> wins<small>${profile.games} games · ${profile.xp} XP</small></td>
    <td><div class="edit-grid"><input data-field="displayName" maxlength="10" value="${escapeHtml(profile.displayName)}" aria-label="Player name"><input data-field="xp" type="number" min="0" value="${profile.xp}" aria-label="XP"><input data-field="games" type="number" min="0" value="${profile.games}" aria-label="Games"><input data-field="wins" type="number" min="0" value="${profile.wins}" aria-label="Wins"><select data-field="featuredTitle" aria-label="Featured title"><option value="none" ${!profile.featuredTitle ? 'selected' : ''}>No title</option><option value="founder" ${profile.featuredTitle?.key === 'founder' ? 'selected' : ''}>Founder</option><option value="triple_champion" ${profile.featuredTitle?.key === 'triple_champion' ? 'selected' : ''}>×4 Champion</option></select><button data-save-profile>Save profile</button></div></td>
    <td><div class="plan-control"><select data-plan>${planOptions(subscription?.planId || 'none')}</select><input data-expiry type="datetime-local" value="${escapeHtml(dateInputValue(subscription?.expiresAt))}" aria-label="Subscription expiry"><button data-save-plan>${subscription ? 'Update / extend' : 'Grant access'}</button><small>${subscription ? `${escapeHtml(subscription.name)} active until ${escapeHtml(formatDate(subscription.expiresAt))}` : 'Free player'}</small></div></td>
    <td><button class="icon-danger" data-delete-profile title="Delete profile" aria-label="Delete ${escapeHtml(profile.displayName)}">×</button></td>
  </tr>`;
}

function renderProfiles() {
  const query = $('#profile-search').value.trim().toLowerCase();
  const visible = profiles.filter(profile => profile.displayName.toLowerCase().includes(query));
  $('#profile-list').innerHTML = visible.length ? visible.map(profileRow).join('') : '<tr><td colspan="5" class="empty compact">No matching profiles.</td></tr>';
}

async function refreshSubscriptions() {
  const data = await api('/api/admin/subscriptions');
  plans = data.plans || [];
  $('#pending-total').textContent = data.pendingCount || 0;
  $('#admin-account').textContent = `${data.account.provider} · ${data.account.accountNumber} · ${data.account.accountName}`;
  $('#payment-requests').innerHTML = data.requests?.length ? data.requests.map(paymentCard).join('') : '<div class="empty compact">No payment requests yet.</div>';
}

async function refreshProfiles() {
  const data = await api('/api/admin/profiles');
  profiles = data.profiles || [];
  $('#profile-total').textContent = profiles.length;
  renderProfiles();
}

async function refreshRecords() {
  try {
    const records = await api('/api/admin/records?limit=12');
    $('#match-total').textContent = records.summary.matches || 0;
    $('#record-player-total').textContent = records.summary.players || 0;
    $('#roll-total').textContent = records.summary.rolls || 0;
    $('#bust-total').textContent = records.summary.busts || 0;
    $('#records-status').textContent = 'Match history is saved with Dice Night.';
    $('#recent-records').innerHTML = records.recent.length ? records.recent.map(match => `<div class="record-row"><span><strong>${escapeHtml(match.winner_name || 'No winner')}</strong> · ${escapeHtml(match.mode)} · ${escapeHtml(match.room_code)}</span><small>${match.winner_score ?? 0} pts · ${escapeHtml(formatDate(match.ended_at))}</small></div>`).join('') : '<p>No completed matches recorded yet.</p>';
    $('#record-leaderboard').innerHTML = records.leaderboard.length ? records.leaderboard.map((player, index) => `<div class="record-row"><span><strong>#${index + 1} ${escapeHtml(player.player_name)}</strong></span><small>${player.wins} wins · ${player.games_played} games</small></div>`).join('') : '<p>Leaderboard appears after the first match.</p>';
  } catch { $('#records-status').textContent = 'Saved records are temporarily unavailable.'; }
}

function roomCard(room) {
  const controls = room.phase === 'lobby' ? '<button data-action="force_start">Force start</button>' : room.phase === 'playing' ? `<button data-action="${room.paused ? 'resume' : 'pause'}">${room.paused ? '▶ Resume' : '⏸ Pause'}</button>` : '<button data-action="reset">New match</button>';
  const playerCards = room.players.map(player => `<article class="player ${player.id === room.hostId ? 'admin' : ''}"><div class="player-name">${escapeHtml(player.name)}${player.frozen ? ' ❄' : ''}${room.phase === 'lobby' ? player.ready ? ' ✓' : ' · waiting' : ''}<small>${player.stats?.rolls || 0} rolls · ${player.stats?.busts || 0} busts · ${player.career?.wins || 0} room wins</small></div><div class="score-tools"><button data-score="-5" data-player="${player.id}">−</button><strong>${player.score}</strong><button data-score="5" data-player="${player.id}">+</button>${player.id === room.hostId ? '' : `<button class="remove" data-remove="${player.id}" title="Remove player">×</button>`}</div></article>`).join('');
  const spectators = (room.spectators || []).map(person => `<button class="spectator-admin" data-remove-spectator="${person.id}" title="Remove spectator">◉ ${escapeHtml(person.name)} ×</button>`).join('');
  return `<article class="room-card" data-room="${room.code}"><div class="room-head"><div class="room-title"><strong class="room-code">${room.code}</strong><span class="phase ${room.paused ? 'paused' : ''}">${room.paused ? 'paused' : room.phase}</span><small>${room.players.length}/9 players</small></div><div class="room-tools">${controls}<select data-mode ${room.phase !== 'lobby' ? 'disabled' : ''}>${['classic','blitz','marathon','showdown','battle'].map(mode => `<option value="${mode}" ${room.mode?.id === mode ? 'selected' : ''}>${mode}</option>`).join('')}</select><select data-timer>${[5,10,15,20,30,45,60].map(seconds => `<option value="${seconds}" ${room.turnDurationMs === seconds * 1000 ? 'selected' : ''}>${seconds} sec</option>`).join('')}</select><button data-action="clear_chat">Clear chat</button><button data-action="reset">Reset</button><button class="danger" data-action="close">Close room</button></div></div><div class="room-body"><div class="players">${playerCards}<div>${spectators}</div></div><aside class="broadcast"><label>ANNOUNCE TO ROOM</label><form data-announce><input maxlength="120" placeholder="Message every player…"><button>Send</button></form><p>Latest: ${escapeHtml(room.message)}</p></aside></div></article>`;
}

async function refreshRooms() {
  const { rooms } = await api('/api/admin/rooms');
  $('#connection').innerHTML = '<i></i> Live';
  $('#room-total').textContent = rooms.length;
  $('#player-total').textContent = rooms.reduce((sum, room) => sum + room.players.length, 0);
  $('#playing-total').textContent = `${rooms.filter(room => room.phase === 'playing').length} playing`;
  $('#rooms').innerHTML = rooms.length ? rooms.map(roomCard).join('') : '<div class="empty">No active rooms yet.</div>';
}

async function refreshAll() {
  try {
    await Promise.all([refreshRooms(), refreshProfiles(), refreshSubscriptions(), refreshRecords(), refreshAnalytics()]);
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
  toast(data.closed ? `Room ${code} closed` : 'Room control applied');
  await refreshRooms();
}

$('#payment-requests').addEventListener('click', async event => {
  const button = event.target.closest('[data-payment]');
  const card = event.target.closest('[data-request]');
  if (!button || !card) return;
  if (button.dataset.payment === 'approved' && !confirm('Have you confirmed this transfer in OPay?')) return;
  try {
    await api(`/api/admin/subscriptions/${encodeURIComponent(card.dataset.request)}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.payment }) });
    toast(button.dataset.payment === 'approved' ? 'Plan activated' : 'Request rejected');
    await Promise.all([refreshSubscriptions(), refreshProfiles()]);
  } catch (error) { toast(error.message, true); }
});

$('#profile-list').addEventListener('click', async event => {
  const row = event.target.closest('[data-profile]');
  if (!row) return;
  const id = row.dataset.profile;
  try {
    if (event.target.closest('[data-save-profile]')) {
      const value = field => row.querySelector(`[data-field="${field}"]`).value;
      await api(`/api/admin/profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ displayName: value('displayName'), xp: Number(value('xp')), games: Number(value('games')), wins: Number(value('wins')), featuredTitle: value('featuredTitle') }) });
      toast('Player profile updated');
    } else if (event.target.closest('[data-save-plan]')) {
      const planId = row.querySelector('[data-plan]').value;
      const expiresAt = row.querySelector('[data-expiry]').value;
      const payload = { planId };
      if (planId !== 'none' && expiresAt) payload.expiresAt = new Date(expiresAt).toISOString();
      await api(`/api/admin/profiles/${encodeURIComponent(id)}/subscription`, { method: 'PATCH', body: JSON.stringify(payload) });
      toast(planId === 'none' ? 'Subscription removed' : 'Subscription access updated');
    } else if (event.target.closest('[data-delete-profile]')) {
      const profile = profiles.find(item => item.id === id);
      if (!confirm(`Permanently delete ${profile?.displayName || 'this player'} and their login?`)) return;
      await api(`/api/admin/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('Player profile deleted');
    } else return;
    await Promise.all([refreshProfiles(), refreshSubscriptions(), refreshRooms()]);
  } catch (error) { toast(error.message, true); }
});

$('#rooms').addEventListener('click', async event => {
  const card = event.target.closest('[data-room]'); if (!card) return;
  const code = card.dataset.room;
  try {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const playerId = event.target.closest('[data-player]')?.dataset.player;
    const removeId = event.target.closest('[data-remove]')?.dataset.remove;
    const removeSpectatorId = event.target.closest('[data-remove-spectator]')?.dataset.removeSpectator;
    if (action) { if (['reset','close'].includes(action) && !confirm(`${action === 'close' ? 'Permanently close' : 'Reset'} room ${code}?`)) return; await sendAction(code, action); }
    else if (playerId) await sendAction(code, 'score', { playerId, delta: Number(event.target.dataset.score) });
    else if (removeId && confirm('Remove this player from the room?')) await sendAction(code, 'remove_player', { playerId: removeId });
    else if (removeSpectatorId && confirm('Remove this spectator?')) await sendAction(code, 'remove_spectator', { playerId: removeSpectatorId });
  } catch (error) { toast(error.message, true); }
});

$('#rooms').addEventListener('change', async event => {
  const card = event.target.closest('[data-room]'); if (!card) return;
  try {
    if (event.target.matches('[data-timer]')) await sendAction(card.dataset.room, 'set_timer', { seconds: Number(event.target.value) });
    if (event.target.matches('[data-mode]')) await sendAction(card.dataset.room, 'set_mode', { mode: event.target.value });
  } catch (error) { toast(error.message, true); }
});

$('#rooms').addEventListener('submit', async event => {
  const form = event.target.closest('[data-announce]'); if (!form) return; event.preventDefault();
  try { await sendAction(form.closest('[data-room]').dataset.room, 'announce', { text: form.querySelector('input').value }); } catch (error) { toast(error.message, true); }
});

$('#profile-search').addEventListener('input', renderProfiles);
$('#reset-leaderboard').addEventListener('click', async () => {
  if (!confirm('Reset every profile score, XP, wins, and saved match record? This cannot be undone.')) return;
  try { await api('/api/admin/leaderboard/reset', { method: 'POST', body: '{}' }); toast('Leaderboard reset'); await refreshAll(); } catch (error) { toast(error.message, true); }
});
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  token = $('#token-input').value.trim();
  if (await refreshAll()) {
    sessionStorage.setItem('dice-night-admin', token);
    $('#login-dialog').close();
    clearInterval(liveTimer); clearInterval(recordsTimer);
    liveTimer = setInterval(() => Promise.all([refreshRooms(), refreshSubscriptions()]).catch(() => {}), 3000);
    recordsTimer = setInterval(() => Promise.all([refreshProfiles(), refreshRecords(), refreshAnalytics()]).catch(() => {}), 15000);
  } else $('#login-error').textContent = 'That key did not work.';
});
$('#refresh-button').addEventListener('click', refreshAll);
$('#lock-button').addEventListener('click', () => {
  sessionStorage.removeItem('dice-night-admin'); token = '';
  clearInterval(liveTimer); clearInterval(recordsTimer);
  $('#token-input').value = ''; $('#login-dialog').showModal();
});

(async function start() {
  if (token && await refreshAll()) {
    liveTimer = setInterval(() => Promise.all([refreshRooms(), refreshSubscriptions()]).catch(() => {}), 3000);
    recordsTimer = setInterval(() => Promise.all([refreshProfiles(), refreshRecords(), refreshAnalytics()]).catch(() => {}), 15000);
  } else $('#login-dialog').showModal();
})();
