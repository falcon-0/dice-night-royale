const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');

const { readJsonFile, writeJsonFile } = require('./json-store');

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_WINDOW_MS = 5 * 60 * 1000;
const KEEP_DAYS = 60;
const EVENT_TYPES = [
  'room_create', 'room_join', 'room_rejoin', 'profile_create', 'profile_login',
  'subscription_request', 'roll', 'risk_die', 'bank', 'freeze', 'chat', 'reaction'
];

function dayKey(value = Date.now()) {
  return new Date(value).toISOString().slice(0, 10);
}

function emptyDay() {
  return { views: 0, visitors: [], devices: { phone: 0, tablet: 0, desktop: 0 }, pages: {}, events: {} };
}

function detectDevice(userAgent = '') {
  const value = String(userAgent).toLowerCase();
  if (/ipad|tablet|kindle|silk/.test(value)) return 'tablet';
  if (/mobile|iphone|ipod|android/.test(value)) return 'phone';
  return 'desktop';
}

function cleanPage(value) {
  return ['home', 'room', 'admin'].includes(value) ? value : 'other';
}

class TrafficAnalytics {
  constructor(file = process.env.ANALYTICS_FILE || path.join(__dirname, 'data', 'analytics.json')) {
    this.file = file;
    this.startedAt = Date.now();
    this.live = new Map();
    this.requests = 0;
    this.errors = 0;
    this.state = this.load();
  }

  load() {
    const stored = readJsonFile(this.file, null);
    const state = stored && typeof stored === 'object' ? stored : {};
    state.version = 1;
    state.salt = typeof state.salt === 'string' && state.salt.length >= 16 ? state.salt : crypto.randomBytes(24).toString('hex');
    state.totalViews = Number.isFinite(state.totalViews) ? state.totalViews : 0;
    state.visitors = Array.isArray(state.visitors) ? state.visitors.filter(value => typeof value === 'string').slice(-50_000) : [];
    state.daily = state.daily && typeof state.daily === 'object' ? state.daily : {};
    for (const [key, value] of Object.entries(state.daily)) {
      const day = value && typeof value === 'object' ? value : emptyDay();
      day.views = Number.isFinite(day.views) ? day.views : 0;
      day.visitors = Array.isArray(day.visitors) ? day.visitors.filter(item => typeof item === 'string') : [];
      day.devices = { phone: 0, tablet: 0, desktop: 0, ...(day.devices || {}) };
      day.pages = day.pages && typeof day.pages === 'object' ? day.pages : {};
      day.events = day.events && typeof day.events === 'object' ? day.events : {};
      state.daily[key] = day;
    }
    state.events = state.events && typeof state.events === 'object' ? state.events : {};
    state.recent = Array.isArray(state.recent) ? state.recent.slice(-50) : [];
    return state;
  }

  persist() {
    const cutoff = Date.now() - KEEP_DAYS * DAY_MS;
    for (const key of Object.keys(this.state.daily)) {
      if (new Date(`${key}T00:00:00.000Z`).getTime() < cutoff) delete this.state.daily[key];
    }
    writeJsonFile(this.file, this.state);
  }

  visitorHash(visitorId) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(String(visitorId || ''))) return null;
    return crypto.createHash('sha256').update(`${this.state.salt}:${visitorId}`).digest('hex');
  }

  trackRequest(failed = false) {
    this.requests += 1;
    if (failed) this.errors += 1;
  }

  trackError() {
    this.errors += 1;
  }

  trackVisit({ visitorId, page, kind = 'heartbeat', userAgent = '', at = Date.now() }) {
    const visitor = this.visitorHash(visitorId);
    if (!visitor) throw Object.assign(new Error('Invalid visitor ID.'), { status: 400 });
    const safePage = cleanPage(page);
    const device = detectDevice(userAgent);
    this.live.set(visitor, { at, page: safePage, device });

    if (kind !== 'view') return;
    const key = dayKey(at);
    const daily = this.state.daily[key] || emptyDay();
    daily.views += 1;
    daily.pages[safePage] = (daily.pages[safePage] || 0) + 1;
    daily.devices[device] = (daily.devices[device] || 0) + 1;
    if (!daily.visitors.includes(visitor)) daily.visitors.push(visitor);
    this.state.daily[key] = daily;
    this.state.totalViews += 1;
    if (!this.state.visitors.includes(visitor)) this.state.visitors.push(visitor);
    this.state.recent.push({ at, visitor: visitor.slice(0, 8).toUpperCase(), page: safePage, device });
    this.state.recent = this.state.recent.slice(-50);
    this.persist();
  }

  trackEvent(type, at = Date.now()) {
    const safeType = EVENT_TYPES.includes(type) ? type : 'other';
    const key = dayKey(at);
    const daily = this.state.daily[key] || emptyDay();
    daily.events[safeType] = (daily.events[safeType] || 0) + 1;
    this.state.daily[key] = daily;
    this.state.events[safeType] = (this.state.events[safeType] || 0) + 1;
    this.persist();
  }

  liveVisitors(now = Date.now()) {
    const cutoff = now - LIVE_WINDOW_MS;
    for (const [visitor, item] of this.live) if (item.at < cutoff) this.live.delete(visitor);
    return [...this.live.values()];
  }

  summary({ rooms = [], profileCount = 0, matchCount = 0, now = Date.now() } = {}) {
    const today = this.state.daily[dayKey(now)] || emptyDay();
    const live = this.liveVisitors(now);
    const days = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(now - offset * DAY_MS);
      const key = dayKey(date);
      const item = this.state.daily[key] || emptyDay();
      days.push({ date: key, views: item.views, visitors: item.visitors.length });
    }
    const roomPlayers = rooms.reduce((sum, room) => sum + (room.players?.length || 0), 0);
    const spectators = rooms.reduce((sum, room) => sum + (room.spectators?.length || 0), 0);
    const memory = process.memoryUsage();
    return {
      generatedAt: now,
      privacy: 'Anonymous visitor IDs are hashed. Raw IP addresses are not stored.',
      traffic: {
        liveVisitors: live.length,
        livePages: live.reduce((counts, item) => ({ ...counts, [item.page]: (counts[item.page] || 0) + 1 }), {}),
        today: { views: today.views, visitors: today.visitors.length, devices: today.devices, pages: today.pages },
        allTime: { views: this.state.totalViews, visitors: this.state.visitors.length },
        trend: days,
        recent: [...this.state.recent].reverse().slice(0, 12)
      },
      activity: {
        today: EVENT_TYPES.reduce((result, type) => ({ ...result, [type]: today.events[type] || 0 }), {}),
        allTime: EVENT_TYPES.reduce((result, type) => ({ ...result, [type]: this.state.events[type] || 0 }), {})
      },
      game: {
        rooms: rooms.length,
        playingRooms: rooms.filter(room => room.phase === 'playing').length,
        seatedPlayers: roomPlayers,
        spectators,
        profiles: profileCount,
        completedMatches: matchCount
      },
      server: {
        status: 'healthy',
        startedAt: this.startedAt,
        uptimeSeconds: Math.floor(process.uptime()),
        requestsSinceStart: this.requests,
        errorsSinceStart: this.errors,
        processMemory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal },
        systemMemory: { free: os.freemem(), total: os.totalmem() },
        cpuCores: os.cpus().length,
        platform: process.platform,
        node: process.version
      }
    };
  }
}

module.exports = { TrafficAnalytics, detectDevice, dayKey };
