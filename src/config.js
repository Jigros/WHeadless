'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { ensureDir } = require('./utils');
const { normalizeProxyConfig } = require('./proxy');

const ROOT_DIR = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

const DEFAULT_CONFIG = {
  server: {
    host: '',
    port: 25565,
    version: '1.21.1',
    target_cardinal_direction: 'NORTH',
    pitch_degrees: -89,
    accept_resource_pack: false,
    resource_pack_policy: 'deny',
    exploit_protection: true,
    close_forced_sign_editor: false,
    early_client_information: true,
    brand: 'vanilla',
    locale: 'en_us',
    view_distance: 12
  },
  auth: {
    profiles_folder: './auth/profiles'
  },
  discord: {
    dashboard_channel_id: '',
    log_channel_id: '',
    dashboard_message_id: '',
    allowed_user_ids: [],
    alert_mention: ''
  },
  donut_api: {
    base_url: 'https://api.donutsmp.net/v1/stats',
    api_key: '',
    balance_json_path: ''
  },
  cashout_nickname: '',
  whitelist: [],
  proxy: null,
  bot_defaults: {
    cashout_reply_wait_ms: 5000,
    cashout_verify_attempts: 6,
    cashout_verify_interval_ms: 5000,
    cashout_verify_min_drop_ratio: 0.8,
    attack_interval_ms: 150,
    axe_scan_interval_ms: 60000,
    balance_interval_ms: 300000,
    profit_window_ms: 300000,
    profit_warmup_ms: 300000,
    profit_reference_per_hour: 47500000,
    profit_reference_min_peer_count: 2,
    profit_reference_use_configured_floor: false,
    profit_alert_enabled: true,
    profit_alert_window_ms: 1200000,
    profit_alert_min_samples: 4,
    profit_alert_min_coverage_percent: 70,
    profit_alert_confirmations: 2,
    profit_alert_drop_percent: 10,
    profit_alert_cooldown_ms: 600000,
    profit_alert_batch_ms: 60000,
    proxy_bad_failure_window_ms: 900000,
    proxy_bad_failure_threshold: 3,
    reconnect_min_ms: 45000,
    reconnect_max_ms: 60000,
    reconnect_on_kick: false,
    scheduled_reconnect_enabled: true,
    scheduled_reconnect_interval_ms: 86400000,
    scheduled_reconnect_jitter_ms: 1800000,
    scheduled_reconnect_busy_retry_ms: 300000,
    teleport_wait_ms: 6500,
    post_spawn_grace_ms: 8000,
    farming_enabled: true,
    packet_trace_limit: 120,
    farm_reach_blocks: 4.5,
    auto_eat_enabled: true,
    auto_eat_min_food: 18,
    auto_eat_critical_food: 8,
    auto_eat_interval_ms: 1000,
    auto_eat_retry_ms: 1500,
    player_alert_enabled: true,
    player_alert_interval_ms: 2000,
    player_alert_cooldown_ms: 300000,
    home_recovery_enabled: true,
    home_recovery_stuck_seconds: 10,
    home_recovery_move_threshold_blocks: 0.2,
    home_recovery_ignore_passive_movement: true,
    home_recovery_discord_cooldown_ms: 600000,
    home_recovery_first_home_delay_seconds: 2,
    home_recovery_retry_start_minutes: 5,
    home_recovery_retry_random_step_minutes: 3,
    home_recovery_retry_max_minutes: 30,
    home_recovery_command_wait_seconds: 8,
    cursor_fallback_enabled: true,
    cursor_fallback_yaw_degrees: [0, 2, -2, 4, -4, 8, -8, 12, -12],
    cursor_fallback_pitch_degrees: [0, 2, -2, 4, -4, 8, -8, 12, -12, 18, -18, 24, -24],
    target_block_names: ['chest', 'trapped_chest', 'barrel'],
    target_cycle_enabled: true,
    suppress_idle_movement_packets: false,
    send_arm_animation: true,
    same_target_block_dig_interval_ms: 425,
    home_trade_command: '/home 2',
    home_farm_command: '/home 1',
    axe_names: ['Shard Sell Axe']
  },
  bots: []
};

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (Array.isArray(base)) return Array.isArray(override) ? override : base.slice();
  if (!isPlainObject(base)) return override === undefined ? base : override;

  const result = { ...base };
  if (!isPlainObject(override)) return result;
  for (const [key, value] of Object.entries(override)) {
    result[key] = deepMerge(base[key], value);
  }
  return result;
}

function resolveProjectPath(value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.join(ROOT_DIR, value);
}

function requireString(errors, value, name) {
  if (!String(value || '').trim()) errors.push(`${name} is required`);
}

function normalizeBot(bot, index) {
  const normalized = { ...bot };
  normalized.username = String(bot.username || '').trim();
  normalized.nickname = String(bot.nickname || '').trim();
  normalized.stats_username = String(bot.stats_username || '').trim();
  normalized.proxy = normalizeProxyConfig(bot.proxy || null);
  normalized.effective_proxy = normalized.proxy; // Only use the specific proxy
  normalized.id = normalized.username || `bot-${index + 1}`;
  return normalized;
}

function validateConfig(config) {
  const errors = [];
  requireString(errors, config.server.host, 'server.host');
  if (!Number.isInteger(config.server.port) || config.server.port < 1 || config.server.port > 65535) {
    errors.push('server.port must be a TCP port');
  }
  if (!['NORTH', 'SOUTH', 'EAST', 'WEST'].includes(config.server.target_cardinal_direction)) {
    errors.push('server.target_cardinal_direction must be NORTH, SOUTH, EAST, or WEST');
  }
  requireString(errors, config.auth.profiles_folder, 'auth.profiles_folder');
  requireString(errors, config.discord.dashboard_channel_id, 'discord.dashboard_channel_id');
  requireString(errors, config.discord.log_channel_id, 'discord.log_channel_id');
  requireString(errors, config.discord.token, 'DISCORD_TOKEN');
  if (!Array.isArray(config.bots) || config.bots.length === 0) {
    errors.push('bots must contain at least one bot');
  }
  for (const [index, bot] of config.bots.entries()) {
    if (!bot.username) errors.push(`bots[${index}].username is required`);
  }
  if (errors.length) {
    throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  }
}

function loadConfig(configPath = path.join(ROOT_DIR, 'config.json')) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config file at ${configPath}. Copy config.example.json to config.json first.`);
  }

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const config = deepMerge(DEFAULT_CONFIG, raw);

  config.server.port = Number(config.server.port);
  config.server.version = String(config.server.version || '1.21.1');
  config.server.target_cardinal_direction = String(config.server.target_cardinal_direction || 'NORTH').toUpperCase();
  config.server.pitch_degrees = Number(config.server.pitch_degrees || 0);
  config.server.view_distance = Number(config.server.view_distance || 12);
  config.server.resource_pack_policy = String(config.server.resource_pack_policy || 'deny').toLowerCase();

  config.auth.profiles_folder = resolveProjectPath(config.auth.profiles_folder);
  config.discord.token = process.env.DISCORD_TOKEN || config.discord.token || '';
  config.discord.allowed_user_ids = Array.isArray(config.discord.allowed_user_ids)
    ? config.discord.allowed_user_ids.map((id) => String(id))
    : [];

  config.donut_api.api_key = process.env.DONUT_API_KEY || config.donut_api.api_key || '';
  config.donut_api.base_url = String(config.donut_api.base_url || DEFAULT_CONFIG.donut_api.base_url).replace(/\/+$/, '');

  config.whitelist = Array.isArray(config.whitelist)
    ? config.whitelist.map((name) => String(name).trim().toLowerCase()).filter(Boolean)
    : [];

  config.proxy = normalizeProxyConfig(config.proxy);
  config.bot_defaults = deepMerge(DEFAULT_CONFIG.bot_defaults, config.bot_defaults || {});
  config.bot_defaults.target_block_names = Array.isArray(config.bot_defaults.target_block_names)
    ? config.bot_defaults.target_block_names.map((name) => String(name).trim().toLowerCase()).filter(Boolean)
    : DEFAULT_CONFIG.bot_defaults.target_block_names.slice();
  config.bot_defaults.axe_names = Array.isArray(config.bot_defaults.axe_names) && config.bot_defaults.axe_names.length
    ? config.bot_defaults.axe_names.map((name) => String(name))
    : DEFAULT_CONFIG.bot_defaults.axe_names.slice();

  config.bots = (config.bots || []).map((bot, index) => normalizeBot(bot, index));
  config.paths = {
    root: ROOT_DIR,
    data_dir: path.join(ROOT_DIR, 'data'),
    dashboard_message: path.join(ROOT_DIR, 'data', 'dashboard-message.json')
  };

  validateConfig(config);
  ensureDir(config.auth.profiles_folder);
  ensureDir(config.paths.data_dir);
  ensureDir(path.join(ROOT_DIR, 'logs'));
  return config;
}

module.exports = {
  DEFAULT_CONFIG,
  ROOT_DIR,
  loadConfig
};
