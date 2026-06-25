'use strict';

const fs = require('node:fs');
const path = require('node:path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  const lo = Math.ceil(Number(min));
  const hi = Math.floor(Number(max));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return lo;
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function degreesToRadians(degrees) {
  return (Number(degrees) * Math.PI) / 180;
}

function yawForCardinal(direction) {
  const value = String(direction || '').toUpperCase();
  if (value === 'NORTH') return Math.PI;
  if (value === 'SOUTH') return 0;
  if (value === 'EAST') return -Math.PI / 2;
  if (value === 'WEST') return Math.PI / 2;
  throw new Error(`Unsupported cardinal direction: ${direction}`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function stripMinecraftFormatting(value) {
  return String(value || '')
    .replace(/\u00a7[0-9A-FK-OR]/gi, '')
    .replace(/\x1B\[[0-9;]*m/g, '');
}

function normalizeText(value) {
  return stripMinecraftFormatting(value).trim().toLowerCase();
}

function truncate(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

function safeStringify(value, maxLength = 1200) {
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(value, (key, inner) => {
      if (typeof inner === 'bigint') return inner.toString();
      if (Buffer.isBuffer(inner)) return inner.toString('utf8');
      if (inner && typeof inner === 'object') {
        if (seen.has(inner)) return '[Circular]';
        seen.add(inner);
      }
      return inner;
    });
    return truncate(json || String(value), maxLength);
  } catch (error) {
    return truncate(String(value), maxLength);
  }
}

function parseMaybeJsonString(value) {
  const text = String(value || '').trim();
  if (!text || !/^[{[]/.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function collectStrings(value, options = {}) {
  const maxDepth = options.maxDepth || 12;
  const maxStrings = options.maxStrings || 400;
  const out = [];
  const seen = new WeakSet();

  function walk(inner, depth) {
    if (out.length >= maxStrings || depth > maxDepth || inner == null) return;
    if (typeof inner === 'string') {
      out.push(stripMinecraftFormatting(inner));
      const parsed = parseMaybeJsonString(inner);
      if (parsed) walk(parsed, depth + 1);
      return;
    }
    if (typeof inner === 'number' || typeof inner === 'boolean' || typeof inner === 'bigint') {
      out.push(String(inner));
      return;
    }
    if (Buffer.isBuffer(inner)) {
      const text = inner.toString('utf8');
      if (text) out.push(stripMinecraftFormatting(text));
      return;
    }
    if (Array.isArray(inner)) {
      for (const item of inner) walk(item, depth + 1);
      return;
    }
    if (typeof inner === 'object') {
      if (seen.has(inner)) return;
      seen.add(inner);
      for (const item of Object.values(inner)) walk(item, depth + 1);
    }
  }

  walk(value, 0);
  return out.filter(Boolean);
}

function parseSelfDestructTimerFromItem(item) {
  if (!item) return { found: false, label: '-', ms: null, expired: false };
  const haystack = collectStrings(item, { maxDepth: 14, maxStrings: 500 }).join('\n');
  const text = stripMinecraftFormatting(haystack);
  const label = text.match(/Self\s*Destruct\s*:?/i);
  if (!label) return { found: false, label: 'Unknown', ms: null, expired: false };

  const window = text.slice(label.index, label.index + 240);
  const ms = parseDurationMs(window) ?? parseDurationMs(text);
  if (ms == null) {
    if (/\b(expired|0\s*[dhms])\b/i.test(window)) {
      return { found: true, label: 'Expired', ms: 0, expired: true };
    }
    return { found: true, label: 'Unknown', ms: null, expired: false };
  }

  if (ms <= 0) {
    return { found: true, label: 'Expired', ms: 0, expired: true };
  }

  return {
    found: true,
    label: formatDuration(ms),
    ms,
    expired: ms <= 0
  };
}

function parseDurationMs(text) {
  const pattern = /(^|[^\d.])(\d+)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?|ins?)?|s(?:ec(?:ond)?s?|ecs?)?)\b/g;
  let match;
  let total = 0;
  let found = false;

  while ((match = pattern.exec(String(text || ''))) !== null) {
    found = true;
    const value = Number(match[2]);
    const unit = match[3];
    if (unit.startsWith('d')) total += value * 24 * 60 * 60 * 1000;
    else if (unit.startsWith('h')) total += value * 60 * 60 * 1000;
    else if (unit.startsWith('m')) total += value * 60 * 1000;
    else if (unit.startsWith('s')) total += value * 1000;
  }

  return found ? total : null;
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '-';
  let seconds = Math.max(0, Math.floor(Number(ms) / 1000));
  const days = Math.floor(seconds / 86400);
  seconds -= days * 86400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || parts.length) parts.push(`${hours}h`);
  if (minutes || parts.length) parts.push(`${minutes}m`);
  if (!parts.length) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return number.toLocaleString('en-US', {
    maximumFractionDigits: Number.isInteger(number) ? 0 : 2
  });
}

function formatCompactMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  const abs = Math.abs(number);
  const sign = number < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${trimCompact(abs / 1_000_000_000)}b`;
  if (abs >= 1_000_000) return `${sign}${trimCompact(abs / 1_000_000)}m`;
  if (abs >= 1_000) return `${sign}${trimCompact(abs / 1_000)}k`;
  return `${sign}${Math.round(abs)}`;
}

function trimCompact(value) {
  const rounded = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return rounded.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function getByPath(value, pathExpression) {
  if (!pathExpression) return undefined;
  const parts = String(pathExpression)
    .replace(/\[(\d+)]/g, '.$1')
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function toNumberLike(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,\s]/g, '');
    if (!cleaned) return null;
    const number = Number(cleaned);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function findBalanceField(value) {
  const seen = new WeakSet();
  const queue = [value];
  while (queue.length) {
    const current = queue.shift();
    if (current == null) continue;
    const direct = toNumberLike(current);
    if (direct != null && queue.length === 0) return direct;
    if (typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);

    for (const [key, inner] of Object.entries(current)) {
      if (/^(money|balance|cash)$/i.test(key)) {
        const number = toNumberLike(inner);
        if (number != null) return number;
      }
      if (inner && typeof inner === 'object') queue.push(inner);
    }
  }
  return null;
}

function parseKickReason(reason) {
  if (reason == null) return '';
  if (reason instanceof Error) return reason.stack || reason.message;
  if (typeof reason === 'string') {
    const parsed = parseMaybeJsonString(reason);
    if (parsed) return collectStrings(parsed).join(' ').trim() || reason;
    return stripMinecraftFormatting(reason);
  }
  return collectStrings(reason).join(' ').trim() || safeStringify(reason);
}

function packetChannelName(packet) {
  if (!packet || typeof packet !== 'object') return '';
  return packet.channel || packet.channelName || packet.identifier || packet.tag || packet.name || '';
}

class PacketTrace {
  constructor(limit) {
    this.limit = Math.max(10, Number(limit) || 120);
    this.entries = [];
  }

  push(direction, packetName, packet) {
    if (shouldIgnorePacketTrace(direction, packetName)) return;
    const channel = packetChannelName(packet);
    const detail = packetTraceDetail(packetName, packet);
    this.entries.push({
      ts: new Date().toISOString(),
      direction,
      name: packetName || 'unknown',
      channel: channel || undefined,
      detail: detail || undefined
    });
    if (this.entries.length > this.limit) this.entries.shift();
  }

  lines(max = 40) {
    return this.entries.slice(-max).map((entry) => {
      const channel = entry.channel ? ` channel=${entry.channel}` : '';
      const detail = entry.detail ? ` ${entry.detail}` : '';
      return `${entry.ts} ${entry.direction} ${entry.name}${channel}${detail}`;
    });
  }
}

function packetTraceDetail(packetName, packet) {
  if (!packet || typeof packet !== 'object') return '';
  if (packetName === 'settings' || packetName === 'client_information') {
    return `locale=${packet.locale} viewDistance=${packet.viewDistance} mainHand=${packet.mainHand}`;
  }
  if (packetName === 'close_window') {
    return `windowId=${packet.windowId}`;
  }
  if (packetName === 'teleport_confirm') {
    return `teleportId=${packet.teleportId}`;
  }
  if (packetName === 'position_look') {
    return `x=${packet.x} y=${packet.y} z=${packet.z} yaw=${packet.yaw} pitch=${packet.pitch} onGround=${packet.onGround}`;
  }
  if (packetName === 'position') {
    return `x=${packet.x} y=${packet.y} z=${packet.z} onGround=${packet.onGround}`;
  }
  if (packetName === 'block_dig') {
    const pos = packet.location || {};
    return `status=${packet.status} seq=${packet.sequence} loc=${pos.x},${pos.y},${pos.z} face=${packet.face}`;
  }
  if (packetName === 'acknowledge_player_digging') {
    return `seq=${packet.sequenceId}`;
  }
  return '';
}

function shouldIgnorePacketTrace(direction, packetName) {
  const name = String(packetName || '').toLowerCase();
  if (name === 'update_time') return true;
  if (name === 'multi_block_change') return true;
  if (name === 'playerlist_header') return true;
  if (name === 'teams') return true;
  if ((name === 'ping' || name === 'pong') && direction === 'in') return true;
  if (name === 'pong' && direction === 'out') return true;
  return false;
}

module.exports = {
  PacketTrace,
  clamp,
  collectStrings,
  degreesToRadians,
  ensureDir,
  findBalanceField,
  formatCompactMoney,
  formatDuration,
  formatMoney,
  getByPath,
  normalizeText,
  parseKickReason,
  parseSelfDestructTimerFromItem,
  randomInt,
  readJsonFile,
  safeStringify,
  sleep,
  stripMinecraftFormatting,
  truncate,
  writeJsonFile,
  yawForCardinal
};
