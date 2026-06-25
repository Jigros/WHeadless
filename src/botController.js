'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mineflayer = require('mineflayer');
const { createHttpAgent, createMineflayerConnect, getProxyLabel } = require('./proxy');
const {
  collectStrings,
  formatCompactMoney,
  normalizeText,
  parseKickReason,
  parseSelfDestructTimerFromItem,
  randomInt,
  safeStringify,
  sleep,
  stripMinecraftFormatting,
  yawForCardinal
} = require('./utils');

const FACE = {
  bottom: 0,
  top: 1,
  north: 2,
  south: 3,
  west: 4,
  east: 5
};

const NEVER_AUTO_EAT_FOOD_NAMES = new Set([
  'chorus_fruit',
  'ominous_bottle',
  'pufferfish',
  'poisonous_potato',
  'spider_eye',
  'suspicious_stew'
]);

const EMERGENCY_AUTO_EAT_FOOD_NAMES = new Set([
  'chicken',
  'rotten_flesh'
]);

const VALUABLE_AUTO_EAT_FOOD_NAMES = new Set([
  'enchanted_golden_apple',
  'golden_apple'
]);

const FALLBACK_AUTO_EAT_FOOD_NAMES = new Set([
  'apple',
  'baked_potato',
  'beef',
  'beetroot',
  'beetroot_soup',
  'bread',
  'carrot',
  'cod',
  'cooked_beef',
  'cooked_chicken',
  'cooked_cod',
  'cooked_mutton',
  'cooked_porkchop',
  'cooked_rabbit',
  'cooked_salmon',
  'cookie',
  'dried_kelp',
  'enchanted_golden_apple',
  'glow_berries',
  'golden_apple',
  'golden_carrot',
  'honey_bottle',
  'melon_slice',
  'mushroom_stew',
  'potato',
  'pumpkin_pie',
  'rabbit',
  'rabbit_stew',
  'salmon',
  'steak',
  'sweet_berries',
  'tropical_fish'
]);

const HOME_RECOVERY = {
  monitoring: 'monitoring',
  delayBeforeHome: 'delay-before-home',
  waitHomeResult: 'wait-home-result',
  waitServerReturn: 'wait-server-return'
};

const HOME_SUCCESS_MARKERS = [
  'you teleported to your home',
  'you were teleported to your home'
];

const MAINTENANCE_MARKER = 'connecting to an area in maintenance';
const PROXY_LIMBO_MARKER = 'proxy limbo';
const SERVER_RESTARTING_MARKER = 'server is restarting';
const SERVER_UPDATING_MARKER = 'servers are updating, do not teleport';
const SERVER_RETURNING_MARKER = 'your region started back up';

class BotController {
  constructor({ botConfig, config, donutApi, logger, manager }) {
    this.botConfig = botConfig;
    this.config = config;
    this.settings = { ...config.bot_defaults, ...botConfig };
    this.donutApi = donutApi;
    this.logger = logger;
    this.manager = manager;
    this.proxy = botConfig.effective_proxy || null;

    this.bot = null;
    this.realUsername = '';
    this.status = 'Idle';
    this.balanceLabel = '-';
    this.axeLabel = '-';
    this.axeAlerted = false;
    this.axeWarning1hSent = false;
    this.pausedAuto = false;
    this.userPaused = false;
    this.disconnectHandled = false;
    this.manualClose = false;
    this.phase = 'idle';
    this.lastKickReason = '';
    this.lastMsaUserCode = '';
    this.lastMsaCodeAt = 0;
    this.announceNextLogin = Boolean(botConfig.announce_login_on_next_start);
    this.reconnectTimer = null;
    this.attackTimer = null;
    this.attackLoopActive = false;
    this.balanceTimer = null;
    this.axeTimer = null;
    this.foodTimer = null;
    this.playerAlertTimer = null;
    this.homeRecoveryTimer = null;
    this.scheduledReconnectTimer = null;
    this.nextScheduledReconnectAt = 0;
    this.noAxeTickCount = 0;
    this.lastBrokenFarmPosKey = null;
    this.lastTargetLogAt = 0;
    this.lastThrottleLog = new Map();
    this.lastPlayerAlertAt = new Map();
    this.proxyFailureTimes = [];
    this.chatLog = [];
    this.tpaInProgress = false;
    this.returnResolver = null;
    this.ticketRetryAt = 0;
    this.isEating = false;
    this.foodAlerted = false;
    this.lastAutoEatAttemptAt = 0;
    this.homeRecoveryState = HOME_RECOVERY.monitoring;
    this.homeRecoveryActionAt = 0;
    this.homeRecoveryMaintenanceStartedAt = 0;
    this.homeRecoveryCurrentRetryMinutes = 0;
    this.homeRecoveryLastMessage = '';
    this.homeRecoveryLastPosition = null;
    this.homeRecoveryLastMovedAt = 0;
    this.homeRecoveryHomeCommandSentAt = 0;
    this.homeRecoveryStuckAfterHomeAlerted = false;
    
    this.sessionEarned = 0;
    this.sessionStartTime = Date.now();
    this.lastBalance = null;
    this.incomeLabel = '-';
    this.profitSamples = [];
    this.currentPerHour = 0;
    this.shortPerHour = 0;
    this.profitReady = false;
    this.lastProfitAlertAt = 0;

  }

  start() {
    this.connect();
  }

  displayName() {
    return (this.bot && this.bot.username) || this.botConfig.nickname || this.botConfig.username;
  }

  statsUsername() {
    return (this.bot && this.bot.username) || this.botConfig.stats_username || this.botConfig.username;
  }

  setStatus(status) {
    this.status = status;
  }

  snapshot() {
    const food = this.bot && Number.isFinite(Number(this.bot.food))
      ? `${Math.max(0, Math.min(20, Math.round(Number(this.bot.food))))}/20`
      : '-/20';
    return {
      name: this.displayName(),
      status: this.status,
      balance: this.balanceLabel || '-',
      axe: this.axeLabel || '-',
      proxy: getProxyLabel(this.proxy),
      income: this.incomeLabel || '-',
      shortIncome: this.shortIncomeLabel || '-',
      hunger: food,
      nextReconnectAt: this.nextScheduledReconnectAt || 0,
      online: Boolean(this.bot && !this.disconnectHandled && !this.userPaused && !this.pausedAuto),
      paused: this.userPaused || this.pausedAuto
    };
  }

  connect() {
    if (this.userPaused) {
      this.setStatus('Paused');
      return;
    }

    if (this.bot && !this.disconnectHandled && (this.phase === 'creating' || this.phase === 'play')) {
      this.logThrottled(
        'connect-already-active',
        `Skipping duplicate connect; phase=${this.phase} status=${this.status}`,
        10000
      );
      return;
    }

    if (this.ticketRetryAt && Date.now() < this.ticketRetryAt) {
      const waitMs = this.ticketRetryAt - Date.now();
      const seconds = Math.max(1, Math.ceil(waitMs / 1000));
      this.setStatus(`Ticket Cooldown (${seconds}s)`);
      this.logger.warn(`Skipping connect during ticket cooldown; retry allowed in ${seconds}s`);
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => this.connect(), waitMs);
      return;
    }

    this.clearReconnectTimer();
    this.disconnectHandled = false;
    this.manualClose = false;
    this.phase = 'creating';
    this.setStatus('Connecting');

    const server = this.config.server;
    const options = {
      host: server.host,
      port: server.port,
      username: this.botConfig.username,
      auth: 'microsoft',
      version: server.version || '1.21.1',
      profilesFolder: this.config.auth.profiles_folder,
      hideErrors: false,
      checkTimeoutInterval: 60000,
      onMsaCode: (data) => {
        this.lastMsaUserCode = String(data.user_code || '');
        this.lastMsaCodeAt = Date.now();
        const expiresIn = Number(data.expires_in);
        const expiresLabel = Number.isFinite(expiresIn) && expiresIn > 0
          ? `\nExpires in: **${Math.ceil(expiresIn / 60)} min**`
          : '';
        const msg = `🚨 **Microsoft Auth Required** for \`${this.botConfig.username}\`!\nGo to ${data.verification_uri} and enter code: **${data.user_code}**${expiresLabel}`;
        this.logger.info(msg);
        this.setStatus('Auth Required');
        if (this.manager.dashboard) {
          this.manager.dashboard.sendLog(msg).catch(e => this.logger.warn('Failed to send MSA code to Discord', e));
        }
      }
    };

    const proxyAgent = createHttpAgent(this.proxy);
    if (proxyAgent) {
      options.agent = proxyAgent;
    } else {
      const proxyConnect = createMineflayerConnect(this.proxy, server.host, server.port, this.logger);
      if (proxyConnect) options.connect = proxyConnect;
    }

    try {
      this.logger.info(
        `Connecting as ${this.botConfig.username} to ${server.host}:${server.port} version=${options.version} proxy=${getProxyLabel(this.proxy)}`
      );
      this.bot = mineflayer.createBot(options);
      this.attachBotEvents(this.bot);
    } catch (error) {
      this.logger.error('createBot failed', error);
      this.bot = null;
      this.scheduleReconnect('createBot failed');
    }
  }

  attachBotEvents(bot) {
    bot.once('login', () => {
      this.realUsername = bot.username || this.realUsername;
      this.lastMsaUserCode = '';
      this.lastMsaCodeAt = 0;
      this.phase = 'play';
      this.setStatus('Logged In');
      const msg = `Microsoft account login successful: ${this.botConfig.username} -> ${this.displayName()}`;
      this.logger.info(msg);
      if (this.announceNextLogin) {
        this.announceNextLogin = false;
        this.botConfig.announce_login_on_next_start = false;
        try {
          const configBot = (this.config.bots || []).find((item) => item.username === this.botConfig.username);
          if (configBot) configBot.announce_login_on_next_start = false;
          const { writeJsonFile } = require('./utils');
          writeJsonFile('config.json', this.config);
        } catch (error) {
          this.logger.warn(`Failed to clear login announcement flag: ${error.message || error}`);
        }
        this.manager.dashboard?.sendLog(`✅ \`${this.displayName()}\` ${msg}`);
      }
    });

    bot.on('spawn', () => {
      this.onSpawn(bot).catch((error) => {
        this.logger.warn('Spawn handler failed', error);
      });
    });

    bot.on('kicked', (reason, loggedIn) => {
      this.lastKickReason = parseKickReason(reason);
      this.logger.warn(`Kicked loggedIn=${Boolean(loggedIn)} reason=${this.lastKickReason || 'unknown'}`);
      this.handleDisconnect('kicked', reason);
    });

    bot.on('end', (reason) => {
      this.handleDisconnect('end', reason);
    });

    bot.on('error', (error) => {
      this.handleDisconnect('error', error);
    });

    bot.on('resourcePack', (...args) => {
      this.handleResourcePack(args).catch((error) => this.logger.warn('Resource pack handler failed', error));
    });

    bot.on('windowOpen', (window) => {
      this.handleWindowOpen(window).catch((error) => this.logger.warn('Window open handler failed', error));
    });

    bot.on('messagestr', (...args) => {
      const rawMsg = stripMinecraftFormatting(args[0] || '').trim();
      this.recordChatLine('IN', rawMsg);
      const myName = this.bot ? this.bot.username : null;
      if (myName && rawMsg.includes(myName)) {
        this.lastChatWithMyName = rawMsg;
        this.lastChatWithMyNameTime = Date.now();
      }
      this.handleHomeRecoveryMessage(rawMsg);
      this.handleMessageString(args[0]);
    });

    bot.on('message', (jsonMsg) => {
      const text = collectStrings(jsonMsg, { maxDepth: 10, maxStrings: 80 }).join(' ') || String(jsonMsg || '');
      this.handleMessageString(text);
    });

    bot.on('chat', (username, message) => {
      this.manager.handleMinecraftCommand(this, username, message).catch((error) => {
        this.logger.warn('Minecraft command failed', error);
      });
    });

    bot.on('diggingCompleted', (block) => {
      // Спам убран
    });

    bot.on('death', () => {
      this.stopAttack(false);
      this.setStatus('Dead / Respawning');
      setTimeout(() => {
        let reason = 'Unknown';
        if (this.lastChatWithMyName && this.lastChatWithMyNameTime && (Date.now() - this.lastChatWithMyNameTime < 3000)) {
          reason = this.lastChatWithMyName;
        }
        const msg = `☠️ \`${this.displayName()}\` died! Reason: *${reason}*`;
        this.logger.warn(`Bot died! Reason: ${reason}`);
        this.manager.dashboard?.sendLog(msg);
      }, 500);
    });

    bot.on('diggingAborted', (block) => {
      // Спам убран
    });

    bot.on('playerCollect', (collector, collected) => {
      if (this.bot && this.bot.entity && collector.id === this.bot.entity.id) {
        if (this.status === 'Waiting Axe') {
          setTimeout(() => this.startFarming().catch(e => this.logger.warn(e)), 500);
        }
      }
    });

    bot.on('health', () => {
      this.autoEat('health').catch(err => this.logger.warn(`autoEat error: ${err.message}`));
    });
  }

  async onSpawn(bot) {
    if (bot !== this.bot) return;
    this.disconnectHandled = false;
    this.phase = 'play';
    this.setStatus('Spawned');
    this.startFoodPolling();

    if (bot.username && this.botConfig.nickname !== bot.username) {
      this.botConfig.nickname = bot.username;
      this.botConfig.stats_username = bot.username;
      try {
        const { writeJsonFile } = require('./utils');
        writeJsonFile('config.json', this.config);
        this.logger.info(`Auto-saved in-game username: ${bot.username}`);
      } catch (e) {}
    }
    await sleep(Number(this.settings.post_spawn_grace_ms) || 8000);
    if (bot !== this.bot || this.disconnectHandled) return;

    await this.lockFarmCamera();
    this.startBalancePolling();
    this.startAxePolling();
    this.startHomeRecoveryPolling();
    this.startPlayerAlertPolling();
    this.scheduleScheduledReconnect();
    this.refreshBalance().catch((error) => this.logger.warn('Initial balance refresh failed', error));

    const ok = await this.checkAxe();
    if (ok) {
      await this.startFarming();
    }
  }

  async handleResourcePack() {
    if (!this.bot) return;
    if (this.config.server.resource_pack_policy === 'deny' || !this.config.server.accept_resource_pack) {
      this.logThrottled('resource-pack-denied-event', 'Denied resource pack event by policy', 30000);
      if (typeof this.bot.denyResourcePack === 'function') this.bot.denyResourcePack();
      return;
    }
    if (typeof this.bot.acceptResourcePack === 'function') this.bot.acceptResourcePack();
  }

  async lockFarmCamera() {
    if (!this.bot || !this.bot.entity) return;
    try {
      const yaw = yawForCardinal(this.config.server.target_cardinal_direction || 'SOUTH');
      const configuredPitch = Number(this.config.server.pitch_degrees);
      const pitchDegrees = Number.isFinite(configuredPitch) ? Math.abs(configuredPitch) : 89;
      const pitch = (pitchDegrees * Math.PI) / 180;
      await this.bot.look(yaw, pitch, true);
      this.logger.info(`Farm camera locked yaw=${radiansToDegrees(yaw).toFixed(1)} pitch=${radiansToDegrees(pitch).toFixed(1)}`);
    } catch (error) {
      this.logger.warn(`Farm camera lock failed: ${error.message || error}`);
    }
  }

  async ensureFarmCameraLocked() {
    if (!this.bot || !this.bot.entity) return;
    const targetYaw = yawForCardinal(this.config.server.target_cardinal_direction || 'SOUTH');
    const configuredPitch = Number(this.config.server.pitch_degrees);
    const targetPitch = ((Number.isFinite(configuredPitch) ? Math.abs(configuredPitch) : 89) * Math.PI) / 180;
    const yawDiff = Math.abs(normalizeRadians((this.bot.entity.yaw || 0) - targetYaw));
    const pitchDiff = Math.abs((this.bot.entity.pitch || 0) - targetPitch);
    if (yawDiff < 0.03 && pitchDiff < 0.03) return;
    await this.lockFarmCamera();
  }

  logThrottled(key, message, intervalMs) {
    const now = Date.now();
    if ((this.lastThrottleLog.get(key) || 0) + intervalMs > now) return;
    this.lastThrottleLog.set(key, now);
    this.logger.warn(message);
  }

  handleDisconnect(kind, reason) {
    if (this.disconnectHandled) return;
    this.disconnectHandled = true;

    const reasonText = parseKickReason(reason) || this.lastKickReason || '';
    this.stopRuntime(false);
    this.logProtocolDiagnostics(kind, reasonText);
    this.forceClose();

    const lowerReason = reasonText.toLowerCase();
    const classification = this.classifyDisconnect(kind, reasonText || reason);
    if (!this.manualClose && !this.userPaused) this.trackProxyFailure(classification);
    if (kind === 'error' && isMicrosoftDeviceCodeExpired(lowerReason)) {
      this.handleAuthCodeExpired(reasonText);
      return;
    }
    
    let emoji = '🔌';
    if (kind === 'kicked') emoji = '🚫';
    if (kind === 'error') emoji = '❌';
    const display = this.displayName();
    this.manager.dashboard?.sendLog(`${emoji} \`${display}\` disconnected. Kind: **${kind}** Category: **${classification.category}**\nReason: \`\`\`\n${classification.message}\n\`\`\``);

    if (this.userPaused) {
      this.setStatus('Paused');
      return;
    }

    if (this.manualClose) {
      if (this.status !== 'Reconnecting') this.setStatus('Offline');
      return;
    }

    if (kind === 'kicked' && lowerReason.includes('already online')) {
      this.clearReconnectTimer();
      this.setStatus('Ghost Session / Wait 1m');
      this.logger.warn('Ghost session detected; auto-reconnecting in 1 minute');
      this.reconnectTimer = setTimeout(() => this.connect(), 60000);
      return;
    }

    if (kind === 'kicked' && (lowerReason.includes('make a ticket') || lowerReason.includes("don't know what happened"))) {
      this.ticketRetryAt = Date.now() + (12 * 60 * 1000);
      this.clearReconnectTimer();
      this.setStatus('Server Ticket / Wait 12m');
      this.logger.warn('Ticket-style kick detected; auto-reconnecting in 12 minutes');
      this.reconnectTimer = setTimeout(() => this.connect(), 12 * 60 * 1000);
      return;
    }

    if (kind === 'kicked' && !this.settings.reconnect_on_kick) {
      this.pausedAuto = true;
      this.setStatus('Kicked / Reconnect Paused');
      return;
    }

    this.scheduleReconnect(kind);
  }

  handleAuthCodeExpired(reasonText) {
    this.pausedAuto = true;
    this.userPaused = true;
    this.setStatus('Auth Code Expired / ON Required');
    this.botConfig.enabled = false;
    try {
      const botConfig = (this.config.bots || []).find((bot) => bot.username === this.botConfig.username);
      if (botConfig) botConfig.enabled = false;
      const { writeJsonFile } = require('./utils');
      writeJsonFile('config.json', this.config);
    } catch (error) {
      this.logger.warn(`Failed to persist auth pause: ${error.message || error}`);
    }

    const codeLabel = this.lastMsaUserCode ? ` Last expired code: ${this.lastMsaUserCode}.` : '';
    const msg = `Microsoft auth code expired for ${this.displayName()}.${codeLabel} Bot is OFF; press ON to request a fresh code.`;
    this.logger.warn(`${msg} ${reasonText || ''}`.trim());
    this.manager.dashboard?.sendLog(`⏳ \`${this.displayName()}\` ${msg}`);
  }

  logProtocolDiagnostics(kind, reasonText) {
    const classification = this.classifyDisconnect(kind, reasonText);
    this.logger.warn(`Disconnected bot=${this.displayName()} kind=${kind} category=${classification.category} phase=${this.phase} reason=${classification.message}`);
  }

  formatDisconnectReason(kind, reason) {
    return this.classifyDisconnect(kind, reason).message;
  }

  classifyDisconnect(kind, reason) {
    const text = stripMinecraftFormatting(String(reason || '')).trim();
    const lower = text.toLowerCase();
    if (!text) return { category: 'Unknown', message: 'No reason provided.' };

    if (lower === 'socketclosed' || lower.includes('socketclosed')) {
      return { category: 'Network', message: 'Network/server socket closed the connection.' };
    }
    if (lower.includes('econnreset')) {
      return { category: 'Network', message: 'Network connection was reset while contacting Minecraft/Mojang services.' };
    }
    if (lower.includes('proxy') || lower.includes('socks') || lower.includes('connect timed out') || lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('ehostunreach')) {
      return { category: 'Proxy', message: 'Proxy connection failed or timed out.' };
    }
    if (lower.includes('failed to obtain profile data') && lower.includes('does the account own minecraft')) {
      return { category: 'Minecraft Profile', message: 'Microsoft account authenticated, but Minecraft Java profile was not found. Check that this account owns Minecraft Java Edition.' };
    }
    if (lower.includes('already online')) {
      return { category: 'Session', message: 'This Minecraft account is already online. Possible ghost session.' };
    }
    if (lower.includes('expired_token') || lower.includes('device code has expired')) {
      return { category: 'Microsoft Auth', message: 'Microsoft device login code expired. Turn the bot ON again to request a fresh code.' };
    }
    if (lower.includes('unauthorized') || lower.includes('invalid credentials')) {
      return { category: 'Microsoft Auth', message: 'Authentication failed. Check Microsoft login/session.' };
    }
    if (lower.includes('timed out') || lower.includes('timeout')) {
      return { category: 'Network', message: 'Connection timed out.' };
    }
    if (kind === 'kicked') {
      const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || text;
      return { category: 'Server Kick', message: firstLine.slice(0, 500) };
    }

    const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || text;
    const message = firstLine
      .replace(new RegExp(escapeRegExp(this.botConfig.username), 'gi'), this.displayName())
      .slice(0, 500);
    return { category: kind === 'error' ? 'Bot/Error' : 'Unknown', message };
  }

  trackProxyFailure(classification) {
    if (!this.proxy || !classification || !['Proxy', 'Network'].includes(classification.category)) return;
    const now = Date.now();
    const windowMs = Math.max(60 * 1000, Number(this.settings.proxy_bad_failure_window_ms) || 15 * 60 * 1000);
    const threshold = Math.max(2, Number(this.settings.proxy_bad_failure_threshold) || 3);
    this.proxyFailureTimes = this.proxyFailureTimes.filter((time) => now - time <= windowMs);
    this.proxyFailureTimes.push(now);
    if (this.proxyFailureTimes.length < threshold || this.botConfig.proxy_bad) return;

    this.botConfig.proxy_bad = true;
    try {
      const configBot = (this.config.bots || []).find((bot) => bot.username === this.botConfig.username);
      if (configBot) configBot.proxy_bad = true;
      const { writeJsonFile } = require('./utils');
      writeJsonFile('config.json', this.config);
    } catch (error) {
      this.logger.warn(`Failed to persist proxy_bad: ${error.message || error}`);
    }

    const label = getProxyLabel(this.proxy);
    const msg = `🌐 \`${this.displayName()}\` proxy marked bad after ${this.proxyFailureTimes.length} network/proxy failures in ${Math.round(windowMs / 60000)}m. Proxy: \`${label}\``;
    this.logger.warn(msg);
    this.manager.dashboard?.sendLog(msg);
  }

  forceClose() {
    const bot = this.bot;
    this.bot = null;
    if (!bot) return;
    try {
      if (bot._client && typeof bot._client.end === 'function') bot._client.end('closed by manager');
    } catch (error) {
      this.logger.debug('client.end failed', error.message || error);
    }
    try {
      if (bot._client && bot._client.socket && !bot._client.socket.destroyed) bot._client.socket.destroy();
    } catch (error) {
      this.logger.debug('socket.destroy failed', error.message || error);
    }
    try {
      if (typeof bot.end === 'function') bot.end();
    } catch (error) {
      this.logger.debug('bot.end failed', error.message || error);
    }
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  clearScheduledReconnectTimer() {
    if (this.scheduledReconnectTimer) clearTimeout(this.scheduledReconnectTimer);
    this.scheduledReconnectTimer = null;
    this.nextScheduledReconnectAt = 0;
  }

  scheduleReconnect(source) {
    if (this.userPaused || this.pausedAuto) return;
    this.clearReconnectTimer();
    const min = Number(this.settings.reconnect_min_ms) || 45000;
    const max = Number(this.settings.reconnect_max_ms) || 60000;
    const delay = randomInt(min, max);
    this.setStatus('Offline / Reconnecting');
    this.logger.info(`Scheduling reconnect in ${Math.round(delay / 1000)}s after ${source}`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  scheduleScheduledReconnect() {
    this.clearScheduledReconnectTimer();
    if (this.settings.scheduled_reconnect_enabled === false) return;
    if (this.userPaused || this.pausedAuto || this.disconnectHandled || !this.bot) return;

    const interval = Math.max(60 * 60 * 1000, Number(this.settings.scheduled_reconnect_interval_ms) || 24 * 60 * 60 * 1000);
    const jitter = Math.max(0, Number(this.settings.scheduled_reconnect_jitter_ms) || 0);
    const delay = interval + (jitter > 0 ? randomInt(0, jitter) : 0);
    this.nextScheduledReconnectAt = Date.now() + delay;
    this.scheduledReconnectTimer = setTimeout(() => {
      this.scheduledReconnectTimer = null;
      this.runScheduledReconnect();
    }, delay);
    this.logger.info(`Scheduled reconnect in ${Math.round(delay / 60000)}m`);
  }

  runScheduledReconnect() {
    this.nextScheduledReconnectAt = 0;
    if (this.userPaused || this.pausedAuto || this.disconnectHandled || !this.bot) return;

    const busyReason = this.scheduledReconnectBusyReason();
    if (busyReason) {
      this.deferScheduledReconnect(busyReason);
      return;
    }

    this.logger.info('Starting scheduled reconnect to refresh long-lived session');
    this.manager.dashboard?.sendLog(`♻️ \`${this.displayName()}\` scheduled reconnect to refresh session.`);
    this.reconnectNow();
  }

  scheduledReconnectBusyReason() {
    if (this.tpaInProgress) return 'TPA in progress';
    if (this.isEating) return 'eating';
    if (this.homeRecoveryState !== HOME_RECOVERY.monitoring) return 'home recovery';
    if (this.status === 'TPA Trade' || this.status === 'Waiting Return') return this.status;
    if (this.status === 'Dead / Respawning') return this.status;
    return '';
  }

  deferScheduledReconnect(reason) {
    const retryMs = Math.max(60 * 1000, Number(this.settings.scheduled_reconnect_busy_retry_ms) || 5 * 60 * 1000);
    this.clearScheduledReconnectTimer();
    this.nextScheduledReconnectAt = Date.now() + retryMs;
    this.scheduledReconnectTimer = setTimeout(() => {
      this.scheduledReconnectTimer = null;
      this.runScheduledReconnect();
    }, retryMs);
    this.logger.info(`Scheduled reconnect deferred for ${Math.round(retryMs / 1000)}s: ${reason}`);
  }

  stopRuntime(sendCancel = true) {
    this.stopAttack(sendCancel);
    if (this.cameraTimer) clearInterval(this.cameraTimer);
    if (this.balanceTimer) clearInterval(this.balanceTimer);
    if (this.axeTimer) clearInterval(this.axeTimer);
    if (this.foodTimer) clearInterval(this.foodTimer);
    if (this.playerAlertTimer) clearInterval(this.playerAlertTimer);
    if (this.homeRecoveryTimer) clearInterval(this.homeRecoveryTimer);
    this.clearScheduledReconnectTimer();
    this.cameraTimer = null;
    this.balanceTimer = null;
    this.axeTimer = null;
    this.foodTimer = null;
    this.playerAlertTimer = null;
    this.homeRecoveryTimer = null;
    if (this.returnResolver) {
      this.returnResolver('disconnect');
      this.returnResolver = null;
    }
  }

  pause(reason = 'Paused') {
    this.safeClose(reason).catch((error) => {
      this.logger.warn('Safe pause failed', error);
      this.userPaused = true;
      this.pausedAuto = false;
      this.manualClose = true;
      this.setStatus(reason);
      this.stopRuntime();
      this.forceClose();
    });
  }

  resume() {
    this.userPaused = false;
    this.pausedAuto = false;
    this.ticketRetryAt = 0;
    if (!this.bot) this.connect();
  }

  reconnectNow() {
    this.safeClose('Reconnecting', false).catch((error) => {
      this.logger.warn('Safe reconnect preparation failed', error);
      this.userPaused = false;
      this.pausedAuto = false;
      this.manualClose = true;
      this.setStatus('Reconnecting');
      this.stopRuntime();
      this.forceClose();
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => this.connect(), 1000);
    });
  }

  async shutdown() {
    try {
      await this.safeClose('Shutdown');
    } catch (error) {
      this.logger.warn('Safe shutdown failed', error);
      this.userPaused = true;
      this.manualClose = true;
      this.setStatus('Shutdown');
      this.stopRuntime();
      this.forceClose();
    }
  }

  async safeClose(reason, pauseUser = true) {
    if (pauseUser) this.userPaused = true;
    else this.userPaused = false;
    this.pausedAuto = false;
    this.manualClose = true;
    this.setStatus(reason);

    this.stopRuntime();
    this.forceClose();

    if (reason === 'Reconnecting') {
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => this.connect(), 1000);
    }
  }

  startBalancePolling() {
    if (this.balanceTimer) clearInterval(this.balanceTimer);
    this.balanceTimer = setInterval(() => {
      this.refreshBalance().catch((error) => this.logger.warn('Balance refresh failed', error));
    }, Number(this.settings.balance_interval_ms) || 15000);
  }

  startAxePolling() {
    if (this.axeTimer) clearInterval(this.axeTimer);
    this.axeTimer = setInterval(() => {
      this.checkAxe().catch((error) => this.logger.warn('Axe check failed', error));
    }, Number(this.settings.axe_scan_interval_ms) || 60000);
  }

  startFoodPolling() {
    if (this.foodTimer) clearInterval(this.foodTimer);
    this.foodTimer = null;
    if (this.settings.auto_eat_enabled === false) return;

    const intervalMs = Math.max(500, Number(this.settings.auto_eat_interval_ms) || 1000);
    this.foodTimer = setInterval(() => {
      this.autoEat('poll').catch((error) => this.logger.warn(`Auto-Eat poll failed: ${error.message || error}`));
    }, intervalMs);

    this.autoEat('spawn').catch((error) => this.logger.warn(`Auto-Eat spawn check failed: ${error.message || error}`));
  }

  startPlayerAlertPolling() {
    if (this.playerAlertTimer) clearInterval(this.playerAlertTimer);
    this.playerAlertTimer = null;
    this.lastPlayerAlertAt.clear();
    if (this.settings.player_alert_enabled === false) return;

    const intervalMs = Math.max(1000, Number(this.settings.player_alert_interval_ms) || 2000);
    this.playerAlertTimer = setInterval(() => {
      this.checkNearbyPlayers();
    }, intervalMs);
    this.checkNearbyPlayers();
  }

  checkNearbyPlayers() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || this.disconnectHandled) return;
    const cooldownMs = Math.max(1000, Number(this.settings.player_alert_cooldown_ms) || 300000);
    const now = Date.now();
    const botPos = this.bot.entity.position;

    for (const entity of Object.values(this.bot.entities || {})) {
      if (!entity || entity === this.bot.entity || entity.type !== 'player' || !entity.position) continue;
      const username = this.playerEntityUsername(entity);
      if (!username || this.shouldIgnoreNearbyPlayer(username)) continue;
      const distance = botPos.distanceTo(entity.position);
      if (!Number.isFinite(distance)) continue;

      const key = username.toLowerCase();
      if ((this.lastPlayerAlertAt.get(key) || 0) + cooldownMs > now) continue;
      this.lastPlayerAlertAt.set(key, now);

      const pos = entity.position;
      const coords = `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`;
      const msg = `👁️ \`${this.displayName()}\` saw non-whitelisted player **${username}** at \`${coords}\` distance \`${distance.toFixed(1)}\` blocks.`;
      this.logger.warn(`Nearby non-whitelisted player: ${username} pos=${coords} distance=${distance.toFixed(1)}`);
      this.manager.dashboard?.sendLog(msg);
    }
  }

  playerEntityUsername(entity) {
    if (!entity) return '';
    if (entity.username) return String(entity.username);
    for (const [username, player] of Object.entries(this.bot.players || {})) {
      if (player && player.entity && player.entity.id === entity.id) return String(username);
    }
    return '';
  }

  shouldIgnoreNearbyPlayer(username) {
    const name = String(username || '').trim();
    if (!name) return true;
    if (this.manager.isWhitelisted(name)) return true;
    const lower = name.toLowerCase();
    const selfNames = [
      this.bot && this.bot.username,
      this.botConfig.username,
      this.botConfig.nickname,
      this.botConfig.stats_username
    ].map((value) => String(value || '').toLowerCase()).filter(Boolean);
    if (selfNames.includes(lower)) return true;
    for (const botConfig of this.config.bots || []) {
      const botNames = [botConfig.nickname, botConfig.stats_username]
        .map((value) => String(value || '').toLowerCase())
        .filter(Boolean);
      if (botNames.includes(lower)) return true;
    }
    return false;
  }

  startHomeRecoveryPolling() {
    if (this.homeRecoveryTimer) clearInterval(this.homeRecoveryTimer);
    this.homeRecoveryTimer = null;
    this.resetHomeRecoveryFlow();
    this.markHomeRecoveryMovement();
    if (this.settings.home_recovery_enabled === false) return;

    this.homeRecoveryTimer = setInterval(() => {
      this.tickHomeRecovery();
    }, 1000);
  }

  tickHomeRecovery() {
    if (!this.bot || !this.bot.entity || this.disconnectHandled) return;
    if (this.bot.isAlive === false) return;

    const now = Date.now();
    switch (this.homeRecoveryState) {
      case HOME_RECOVERY.monitoring:
        this.tickHomeRecoveryMonitoring(now);
        break;
      case HOME_RECOVERY.delayBeforeHome:
        if (now >= this.homeRecoveryActionAt) this.tryHomeRecoveryTeleport();
        break;
      case HOME_RECOVERY.waitHomeResult:
        if (now >= this.homeRecoveryActionAt) this.scheduleHomeRecoveryRetry();
        break;
      case HOME_RECOVERY.waitServerReturn:
        this.tickHomeRecoveryServerReturn(now);
        break;
      default:
        this.resetHomeRecoveryFlow();
        break;
    }
  }

  tickHomeRecoveryMonitoring(now) {
    if (this.shouldPauseHomeRecoveryMovementCheck()) {
      this.markHomeRecoveryMovement(now);
      return;
    }

    const moved = this.updateHomeRecoveryMovement(now);
    if (moved) return;

    const stuckMs = this.getHomeRecoveryStuckMs();
    if (!this.homeRecoveryLastMovedAt || now - this.homeRecoveryLastMovedAt < stuckMs) return;

    this.beginHomeRecoveryDelay(`No movement for ${Math.round(stuckMs / 1000)}s`);
  }

  tickHomeRecoveryServerReturn(now) {
    if (this.updateHomeRecoveryMovement(now)) {
      if (this.homeRecoveryMaintenanceStartedAt > 0) {
        this.notifyHomeRecovery(`Server returned bot after ${formatDuration(now - this.homeRecoveryMaintenanceStartedAt)}.`, true);
      }
      this.finishHomeRecovery('server-return');
      return;
    }

    const stuckMs = this.getHomeRecoveryStuckMs();
    if (!this.homeRecoveryLastMovedAt || now - this.homeRecoveryLastMovedAt < stuckMs) return;
    this.beginHomeRecoveryDelay(`No movement for ${Math.round(stuckMs / 1000)}s after server return`);
  }

  shouldPauseHomeRecoveryMovementCheck() {
    if (this.userPaused || this.pausedAuto || this.tpaInProgress || this.isEating) return true;
    if (this.status === 'TPA Trade' || this.status === 'Waiting Return') return true;
    if (this.status === 'Dead / Respawning') return true;
    return false;
  }

  getHomeRecoveryStuckMs() {
    const seconds = Number(this.settings.home_recovery_stuck_seconds);
    return Math.max(1, Number.isFinite(seconds) ? seconds : 10) * 1000;
  }

  getHomeRecoveryMoveThreshold() {
    const blocks = Number(this.settings.home_recovery_move_threshold_blocks);
    return Math.max(0.05, Number.isFinite(blocks) ? blocks : 1);
  }

  markHomeRecoveryMovement(now = Date.now()) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return;
    this.homeRecoveryLastPosition = this.bot.entity.position.clone();
    this.homeRecoveryLastMovedAt = now;
  }

  updateHomeRecoveryMovement(now = Date.now()) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;
    const position = this.bot.entity.position;
    if (!this.homeRecoveryLastPosition) {
      this.markHomeRecoveryMovement(now);
      return true;
    }

    const distance = position.distanceTo(this.homeRecoveryLastPosition);
    if (distance < this.getHomeRecoveryMoveThreshold()) return false;

    this.homeRecoveryLastPosition = position.clone();
    this.homeRecoveryLastMovedAt = now;
    return true;
  }

  beginHomeRecoveryDelay(reason) {
    if (!this.bot || this.disconnectHandled) return;
    const delayMs = Math.max(0, Number(this.settings.home_recovery_first_home_delay_seconds) || 0) * 1000;
    this.homeRecoveryState = HOME_RECOVERY.delayBeforeHome;
    this.homeRecoveryActionAt = Date.now() + delayMs;
    this.stopAttack(true);
    this.setStatus('Home Recovery');
    this.notifyHomeRecovery(`${reason}. Sending ${this.normalizedHomeCommand()} in ${Math.round(delayMs / 1000)}s.`, true);
  }

  tryHomeRecoveryTeleport() {
    const command = this.normalizedHomeCommand();
    if (!command) {
      this.scheduleHomeRecoveryRetry();
      return;
    }

    this.stopAttack(true);
    this.sendChat(command);
    this.homeRecoveryHomeCommandSentAt = Date.now();
    this.homeRecoveryState = HOME_RECOVERY.waitHomeResult;
    this.homeRecoveryActionAt = Date.now() + this.getHomeRecoveryCommandWaitMs();
    this.setStatus('Home Recovery / Waiting');
    this.notifyHomeRecovery(`Sent ${command}; waiting for home or maintenance chat.`, false);
  }

  getHomeRecoveryCommandWaitMs() {
    const seconds = Number(this.settings.home_recovery_command_wait_seconds);
    return Math.max(1, Number.isFinite(seconds) ? seconds : 8) * 1000;
  }

  scheduleHomeRecoveryRetry() {
    this.alertHomeRecoveryStillStuck();
    const minutes = this.nextHomeRecoveryRetryMinutes();
    this.homeRecoveryState = HOME_RECOVERY.delayBeforeHome;
    this.homeRecoveryActionAt = Date.now() + minutes * 60000;
    const label = this.homeRecoveryMaintenanceStartedAt > 0 ? 'Maintenance Retry' : 'Home Retry';
    this.setStatus(`${label} (${minutes}m)`);
    this.notifyHomeRecovery(`Next ${this.normalizedHomeCommand()} retry in ${minutes} minute(s).`, true);
  }

  alertHomeRecoveryStillStuck() {
    if (this.homeRecoveryStuckAfterHomeAlerted) return;
    if (this.homeRecoveryMaintenanceStartedAt > 0) return;
    if (!this.homeRecoveryHomeCommandSentAt) return;
    this.homeRecoveryStuckAfterHomeAlerted = true;
    this.manager.alertCritical(
      this,
      `Home Recovery: still stuck after ${this.normalizedHomeCommand()}; no recovery confirmed after ${formatDuration(Date.now() - this.homeRecoveryHomeCommandSentAt)}`
    );
  }

  nextHomeRecoveryRetryMinutes() {
    const start = Math.max(1, Number(this.settings.home_recovery_retry_start_minutes) || 5);
    const max = Math.max(start, Number(this.settings.home_recovery_retry_max_minutes) || 30);
    const maxStep = Math.max(1, Number(this.settings.home_recovery_retry_random_step_minutes) || 3);

    let next;
    if (this.homeRecoveryCurrentRetryMinutes <= 0) {
      next = start;
    } else if (this.homeRecoveryCurrentRetryMinutes >= max) {
      const minAtCap = Math.max(start, max - maxStep);
      next = randomInt(minAtCap, max);
      if (minAtCap < max && next === this.homeRecoveryCurrentRetryMinutes) {
        next = next >= max ? minAtCap : next + 1;
      }
    } else {
      next = Math.min(max, this.homeRecoveryCurrentRetryMinutes + randomInt(1, maxStep));
    }

    this.homeRecoveryCurrentRetryMinutes = next;
    return next;
  }

  handleHomeRecoveryMessage(message) {
    if (this.settings.home_recovery_enabled === false) return;
    const text = stripMinecraftFormatting(message || '').trim();
    if (!text) return;
    const lower = text.toLowerCase();

    if (this.isHomeRecoveryProxyLimboMessage(lower)) {
      this.handleHomeRecoveryProxyLimbo(text);
      return;
    }
    if (lower.includes(SERVER_RETURNING_MARKER)) {
      this.handleHomeRecoveryServerReturning(text);
      return;
    }
    if (lower.includes(SERVER_UPDATING_MARKER)) {
      this.logThrottled('home-recovery-server-updating', `Home Recovery: server update warning: ${text}`, 30000);
      return;
    }
    if (lower.includes(MAINTENANCE_MARKER)) {
      this.handleHomeRecoveryMaintenance(text);
      return;
    }
    if (HOME_SUCCESS_MARKERS.some((marker) => lower.includes(marker))) {
      this.handleHomeRecoverySuccess(text);
    }
  }

  isHomeRecoveryProxyLimboMessage(lower) {
    return lower.includes(PROXY_LIMBO_MARKER) || (lower.includes(SERVER_RESTARTING_MARKER) && lower.includes('limbo'));
  }

  handleHomeRecoveryProxyLimbo(message) {
    this.homeRecoveryLastMessage = message;
    if (this.homeRecoveryMaintenanceStartedAt <= 0) {
      this.homeRecoveryMaintenanceStartedAt = Date.now();
      this.notifyHomeRecovery(`Proxy limbo/restart detected: ${message}`, true);
    }
    this.beginHomeRecoveryDelay('Proxy limbo/restart chat detected');
  }

  handleHomeRecoveryMaintenance(message) {
    this.homeRecoveryLastMessage = message;
    if (this.homeRecoveryMaintenanceStartedAt <= 0) {
      this.homeRecoveryMaintenanceStartedAt = Date.now();
      this.notifyHomeRecovery(`Maintenance detected: ${message}`, true);
    }
    this.scheduleHomeRecoveryRetry();
  }

  handleHomeRecoveryServerReturning(message) {
    this.homeRecoveryLastMessage = message;
    if (this.homeRecoveryMaintenanceStartedAt <= 0) {
      this.homeRecoveryMaintenanceStartedAt = Date.now();
      this.notifyHomeRecovery(`Server return detected: ${message}`, true);
    }
    this.homeRecoveryState = HOME_RECOVERY.waitServerReturn;
    this.homeRecoveryActionAt = 0;
    this.markHomeRecoveryMovement();
    this.setStatus('Server Return Wait');
  }

  handleHomeRecoverySuccess(message) {
    const wasRecovering = this.homeRecoveryState !== HOME_RECOVERY.monitoring || this.homeRecoveryMaintenanceStartedAt > 0;
    if (!wasRecovering) {
      this.markHomeRecoveryMovement();
      return;
    }

    if (this.homeRecoveryMaintenanceStartedAt > 0) {
      this.notifyHomeRecovery(`Home teleport confirmed after ${formatDuration(Date.now() - this.homeRecoveryMaintenanceStartedAt)}: ${message}`, true);
    } else {
      this.notifyHomeRecovery(`Home teleport confirmed: ${message}`, false);
    }
    this.finishHomeRecovery('home-success');
  }

  finishHomeRecovery(source) {
    this.resetHomeRecoveryFlow();
    this.markHomeRecoveryMovement();
    this.setStatus('Ready');
    setTimeout(() => {
      if (!this.bot || this.disconnectHandled || this.tpaInProgress) return;
      this.lockFarmCamera().catch((error) => this.logger.warn(`Home recovery camera lock failed: ${error.message || error}`));
      this.startFarming().catch((error) => this.logger.warn(`Home recovery restart failed: ${error.message || error}`));
    }, source === 'server-return' ? 1000 : 1500);
  }

  resetHomeRecoveryFlow() {
    this.homeRecoveryState = HOME_RECOVERY.monitoring;
    this.homeRecoveryActionAt = 0;
    this.homeRecoveryMaintenanceStartedAt = 0;
    this.homeRecoveryCurrentRetryMinutes = 0;
    this.homeRecoveryLastMessage = '';
    this.homeRecoveryHomeCommandSentAt = 0;
    this.homeRecoveryStuckAfterHomeAlerted = false;
  }

  normalizedHomeCommand() {
    return String(this.settings.home_farm_command || '/home 1').trim();
  }

  notifyHomeRecovery(message, discord = false) {
    const line = `Home Recovery: ${message}`;
    this.logger.warn(line);
    if (discord) this.manager.dashboard?.sendLog(`🏠 \`${this.displayName()}\` ${line}`);
  }

  async refreshBalance() {
    const username = this.statsUsername();
    const result = await this.donutApi.getBalance(username, {
      botKey: this.botConfig.username,
      displayName: this.displayName()
    });
    
    if (result.ok && Number.isFinite(result.balance)) {
      const now = Date.now();
      if (this.lastBalance === null) {
        // Первое измерение баланса (бот только зашел)
        this.sessionStartTime = now;
        this.profitSamples = [{ at: now, balance: result.balance }];
      } else if (result.balance > this.lastBalance) {
        // Второе и последующие измерения
        this.sessionEarned += (result.balance - this.lastBalance);
        this.profitSamples.push({ at: now, balance: result.balance });
      } else if (result.balance < this.lastBalance) {
        // Баланс упал (произошел Cashout). 
        // Статистика сломалась из-за задержки API, поэтому мы просто начинаем сессию заново!
        this.sessionStartTime = now;
        this.sessionEarned = 0;
        this.currentPerHour = 0;
        this.shortPerHour = 0;
        this.profitReady = false;
        this.profitSamples = [{ at: now, balance: result.balance }];
      } else {
        this.profitSamples.push({ at: now, balance: result.balance });
      }
      this.lastBalance = result.balance;
      
      this.updateProfitMetrics(now);
      this.checkProfitAlert(now);
    }
    
    this.balanceLabel = result.label;
    return result;
  }

  updateProfitMetrics(now = Date.now()) {
    const windowMs = Math.max(60 * 1000, Number(this.settings.profit_window_ms) || 5 * 60 * 1000);
    const warmupMs = Math.max(windowMs, Number(this.settings.profit_warmup_ms) || windowMs);
    const keepAfter = now - Math.max(windowMs * 3, warmupMs + windowMs);
    this.profitSamples = this.profitSamples
      .filter((sample) => sample && Number.isFinite(sample.balance) && Number.isFinite(sample.at) && sample.at >= keepAfter)
      .sort((a, b) => a.at - b.at);

    const sessionHours = (now - this.sessionStartTime) / 3600000;
    this.currentPerHour = this.sessionEarned > 0 && sessionHours > 0.0001
      ? this.sessionEarned / sessionHours
      : 0;

    const shortRate = this.calculateWindowRate(now, windowMs);
    this.shortPerHour = shortRate;
    this.profitReady = (now - this.sessionStartTime) >= warmupMs && this.profitSamples.length >= 3;

    const shortLabel = shortRate > 0 ? `$${formatCompactMoney(shortRate)}/h` : '$0/h';
    const longLabel = this.currentPerHour > 0 ? `$${formatCompactMoney(this.currentPerHour)}/h` : '$0/h';
    const trend = this.profitTrendIcon();
    this.shortIncomeLabel = `${trend} ${shortLabel}`;
    this.incomeLabel = `${trend} ${shortLabel} avg ${longLabel}`;
  }

  calculateWindowRate(now, windowMs) {
    if (!this.profitSamples.length) return 0;
    const newest = this.profitSamples[this.profitSamples.length - 1];
    let oldest = this.profitSamples[0];
    const cutoff = now - windowMs;
    for (const sample of this.profitSamples) {
      if (sample.at <= cutoff) oldest = sample;
      else break;
    }
    if (!oldest || newest.at <= oldest.at) return 0;
    const earned = newest.balance - oldest.balance;
    if (earned <= 0) return 0;
    return earned / ((newest.at - oldest.at) / 3600000);
  }

  profitTrendIcon() {
    if (!this.profitReady) return '⏳';
    const reference = this.manager.getProfitReferencePerHour(this);
    if (!reference || this.shortPerHour <= 0) return '⚠️';
    const ratio = this.shortPerHour / reference;
    if (ratio < 0.9) return '🔻';
    if (ratio > 1.1) return '🔺';
    return '➖';
  }

  checkProfitAlert(now = Date.now()) {
    if (!this.profitReady) return;
    const cooldownMs = Math.max(60 * 1000, Number(this.settings.profit_alert_cooldown_ms) || 10 * 60 * 1000);
    if (this.lastProfitAlertAt + cooldownMs > now) return;

    const reference = this.manager.getProfitReferencePerHour(this);
    const dropPercent = Math.max(1, Number(this.settings.profit_alert_drop_percent) || 10);
    const threshold = reference * (1 - dropPercent / 100);
    if (!reference || this.shortPerHour >= threshold) return;

    this.lastProfitAlertAt = now;
    const msg = [
      `📉 \`${this.displayName()}\` sales dropped.`,
      `Now: \`$${formatCompactMoney(this.shortPerHour)}/h\``,
      `Reference: \`$${formatCompactMoney(reference)}/h\``,
      `Drop: \`${Math.round((1 - (this.shortPerHour / reference)) * 100)}%\``
    ].join(' ');
    this.logger.warn(`Profit alert: short=${formatCompactMoney(this.shortPerHour)}/h reference=${formatCompactMoney(reference)}/h`);
    this.manager.dashboard?.sendLog(msg);
  }

  async cashout() {
    if (!this.bot || this.disconnectHandled) return false;
    const result = await this.refreshBalance();
    if (!result.ok || !Number.isFinite(result.balance) || result.balance <= 0) return false;
    const cashoutNickname = String(this.config.cashout_nickname || '').trim();
    if (!cashoutNickname) {
      this.logger.warn('cashout_nickname is not configured');
      return false;
    }
    
    const amount = Math.floor(result.balance);
    if (amount <= 0) return false;

    let hasError = false;
    let lastErrorMsg = '';

    const replyListener = (jsonMsg) => {
      try {
        const { collectStrings, stripMinecraftFormatting } = require('./utils');
        const text = collectStrings(jsonMsg, { maxDepth: 10 }).join(' ');
        const rawText = stripMinecraftFormatting(text).trim();
        if (rawText && !rawText.startsWith('<') && !rawText.startsWith('[') && rawText.length > 5) {
          if (rawText.toLowerCase().includes('cannot') || rawText.toLowerCase().includes('error') || rawText.toLowerCase().includes('must') || rawText.toLowerCase().includes('limit')) {
            hasError = true;
            lastErrorMsg = rawText;
          }
        }
      } catch(e) {}
    };

    this.bot.on('message', replyListener);

    this.bot.chat(`/pay ${cashoutNickname} ${amount}`);
    this.logger.info(`Cashout sent: /pay ${cashoutNickname} ${amount}`);
    
    await sleep(4000); // Ждем ответ сервера
    
    if (hasError) {
      this.logger.warn(`Cashout error caught: ${lastErrorMsg}. Retrying...`);
      hasError = false; // сбрасываем для второй попытки
      this.bot.chat(`/pay ${cashoutNickname} ${amount}`);
      await sleep(4000);
      
      if (hasError) {
        this.manager.dashboard?.sendLog(`❌ \`${this.displayName()}\` failed to cashout. Error: **${lastErrorMsg}**`);
        this.bot.removeListener('message', replyListener);
        return false;
      }
    }

    this.bot.removeListener('message', replyListener);
    const msg = `💸 \`${this.displayName()}\` successfully transferred **$${amount.toLocaleString('en-US')}** to \`${cashoutNickname}\``;
    this.manager.dashboard?.sendLog(msg);
    return true;
  }

  async checkAxe() {
    if (!this.bot || this.disconnectHandled) return false;
    const result = await this.ensureAxeEquipped();
    if (!result.ok) {
      this.handleAxeUnavailable(result.reason);
      return false;
    }
    
    if (result.timer && result.timer.ms != null) {
      if (result.timer.ms <= 3600000 && result.timer.ms > 0) {
        if (!this.axeWarning1hSent) {
          this.axeWarning1hSent = true;
          const msg = `⚠️ \`${this.displayName()}\` Axe expires in **less than 1 hour**! пинг @everyone`;
          this.logger.warn(`Axe expires in < 1h for ${this.displayName()}`);
          this.manager.dashboard?.sendLog(msg);
        }
      } else if (result.timer.ms > 3600000) {
        this.axeWarning1hSent = false;
      }
    }

    this.axeAlerted = false;
    if (this.status === 'Waiting Axe') this.setStatus('Ready');
    return true;
  }

  async autoEat(source = 'manual') {
    if (this.settings.auto_eat_enabled === false) return false;
    if (!this.bot || this.disconnectHandled || this.isEating) return false;
    if (this.bot.isAlive === false) return false;

    const currentFood = Number(this.bot.food);
    if (!Number.isFinite(currentFood)) return false;
    const minFood = this.getAutoEatMinFood();
    if (currentFood > minFood) return false;

    const retryMs = Math.max(250, Number(this.settings.auto_eat_retry_ms) || 1500);
    const now = Date.now();
    if (this.lastAutoEatAttemptAt + retryMs > now) return false;
    this.lastAutoEatAttemptAt = now;

    const foodItem = this.findBestFoodItem(currentFood);
    if (!foodItem) {
      this.handleNoFoodAvailable(currentFood);
      return false;
    }

    this.foodAlerted = false;
    this.isEating = true;
    const wasFarming = this.attackLoopActive;
    const previousStatus = this.status;
    const beforeFood = Number.isFinite(currentFood) ? currentFood : '?';
    if (wasFarming || this.isDigging()) this.stopAttack(true);

    this.setStatus(`Eating (${beforeFood}/20)`);
    try {
      this.logger.info(`Auto-Eat ${source}: eating ${this.describeItem(foodItem)} food=${beforeFood}/20`);
      await this.bot.equip(foodItem, 'hand');
      await this.bot.consume();
      const afterFood = this.bot && Number.isFinite(Number(this.bot.food)) ? Number(this.bot.food) : '?';
      this.logger.info(`Auto-Eat ${source}: ate ${foodItem.name}; food ${beforeFood}/20 -> ${afterFood}/20`);
      return true;
    } catch (err) {
      this.logger.warn(`Auto-Eat ${source} failed for ${foodItem.name}: ${err.message || err}`);
      return false;
    } finally {
      this.isEating = false;

      if (this.bot && !this.disconnectHandled) {
        let axeReady = false;
        try {
          axeReady = await this.checkAxe();
        } catch (error) {
          this.logger.warn(`Auto-Eat ${source}: failed to restore axe: ${error.message || error}`);
        }

        if (wasFarming && axeReady) {
          await this.startFarming();
        } else if (this.status.startsWith('Eating')) {
          this.setStatus(previousStatus && previousStatus !== 'Farming' ? previousStatus : 'Ready');
        }
      }
    }
  }

  getAutoEatMinFood() {
    const configured = Number(this.settings.auto_eat_min_food);
    if (!Number.isFinite(configured)) return 18;
    return Math.max(1, Math.min(19, Math.floor(configured)));
  }

  getAutoEatCriticalFood() {
    const configured = Number(this.settings.auto_eat_critical_food);
    if (!Number.isFinite(configured)) return 8;
    return Math.max(1, Math.min(this.getAutoEatMinFood(), Math.floor(configured)));
  }

  getFoodData(item) {
    if (!item || !item.name) return null;
    const fromRegistry = this.bot && this.bot.registry && this.bot.registry.foodsByName
      ? this.bot.registry.foodsByName[item.name]
      : null;
    if (fromRegistry) return fromRegistry;
    if (!FALLBACK_AUTO_EAT_FOOD_NAMES.has(item.name)) return null;
    return {
      name: item.name,
      foodPoints: 1,
      saturation: 0,
      effectiveQuality: 1
    };
  }

  findBestFoodItem(currentFood) {
    if (!this.bot || !this.bot.inventory) return null;
    const criticalFood = this.getAutoEatCriticalFood();
    const allowEmergencyFood = currentFood <= criticalFood;
    const candidates = this.bot.inventory.items()
      .map((item) => ({ item, food: this.getFoodData(item) }))
      .filter(({ item, food }) => {
        if (!food) return false;
        if (NEVER_AUTO_EAT_FOOD_NAMES.has(item.name)) return false;
        if (EMERGENCY_AUTO_EAT_FOOD_NAMES.has(item.name) && !allowEmergencyFood) return false;
        return true;
      });

    if (!candidates.length) return null;

    const normal = candidates.filter(({ item }) => (
      !VALUABLE_AUTO_EAT_FOOD_NAMES.has(item.name) && !EMERGENCY_AUTO_EAT_FOOD_NAMES.has(item.name)
    ));
    const valuable = candidates.filter(({ item }) => VALUABLE_AUTO_EAT_FOOD_NAMES.has(item.name));
    const emergency = candidates.filter(({ item }) => EMERGENCY_AUTO_EAT_FOOD_NAMES.has(item.name));
    const pool = normal.length ? normal : (valuable.length ? valuable : emergency);

    pool.sort((a, b) => {
      const aQuality = Number(a.food.effectiveQuality || a.food.foodPoints || 0);
      const bQuality = Number(b.food.effectiveQuality || b.food.foodPoints || 0);
      if (bQuality !== aQuality) return bQuality - aQuality;
      const aFood = Number(a.food.foodPoints || 0);
      const bFood = Number(b.food.foodPoints || 0);
      if (bFood !== aFood) return bFood - aFood;
      return Number(a.item.slot || 0) - Number(b.item.slot || 0);
    });

    return pool[0] ? pool[0].item : null;
  }

  handleNoFoodAvailable(currentFood) {
    const foodLabel = `${currentFood}/20`;
    const inventory = this.bot && this.bot.inventory
      ? this.bot.inventory.items().map((item) => item.name).slice(0, 24).join(', ')
      : '';
    this.logThrottled(
      'auto-eat-no-food',
      `Auto-Eat: no usable food found food=${foodLabel} inventory=${inventory || 'empty'}`,
      10000
    );

    if (this.foodAlerted) return;
    if (currentFood > this.getAutoEatCriticalFood()) return;

    this.foodAlerted = true;
    this.manager.alertCritical(this, `Auto-Eat: no usable food found; hunger is ${foodLabel}`);
  }

  async ensureAxeEquipped() {
    if (!this.bot) return { ok: false, reason: 'offline' };
    const held = this.bot.heldItem;
    if (this.matchesAxe(held)) return this.inspectAxe(held);

    const item = this.findAxeItem();
    if (!item) return { ok: false, reason: 'axe missing' };

    try {
      await this.bot.equip(item, 'hand');
      await sleep(150);
    } catch (error) {
      return { ok: false, reason: `equip failed: ${error.message || error}` };
    }
    return this.inspectAxe(this.bot.heldItem || item);
  }

  inspectAxe(item) {
    const timer = parseSelfDestructTimerFromItem(item);
    if (timer.ms != null && timer.ms > 0) {
      const expirationSeconds = Math.floor((Date.now() + timer.ms) / 1000);
      this.axeLabel = `<t:${expirationSeconds}:R>`;
    } else {
      this.axeLabel = timer.label || 'Unknown';
    }
    if (timer.expired) return { ok: false, reason: 'axe expired' };
    return { ok: true, timer };
  }

  handleAxeUnavailable(reason) {
    this.axeLabel = reason || 'Missing';
    this.stopAttack(true);
    this.setStatus('Waiting Axe');
    if (!this.axeAlerted) {
      this.axeAlerted = true;
      this.manager.alertCritical(this, `Axe unavailable: ${reason || 'missing'} пинг @everyone`);
    }
  }

  matchesAxe(item) {
    if (!item) return false;
    const targets = (Array.isArray(this.settings.axe_names) ? this.settings.axe_names : ['Shard Sell Axe'])
      .map((name) => normalizeText(name))
      .filter(Boolean);
    const strings = [
      item.displayName,
      item.customName,
      item.name,
      ...collectStrings(item.nbt, { maxDepth: 10, maxStrings: 120 }),
      ...collectStrings(item.components, { maxDepth: 10, maxStrings: 120 })
    ].map((value) => normalizeText(value));

    return targets.some((target) => strings.some((value) => value.includes(target)));
  }

  findAxeItem() {
    if (!this.bot || !this.bot.inventory) return null;
    return this.bot.inventory.items().find((item) => this.matchesAxe(item)) || null;
  }

  currentAxeSignature() {
    const item = (this.bot && this.bot.heldItem && this.matchesAxe(this.bot.heldItem))
      ? this.bot.heldItem
      : this.findAxeItem();
    if (!item) return '';
    return `${item.type}:${item.count}:${safeStringify(item.nbt || item.components || item, 1200)}`;
  }

  async startFarming() {
    if (!this.settings.farming_enabled || this.attackLoopActive || !this.bot || this.disconnectHandled) return false;
    const ok = await this.checkAxe();
    if (!ok) return false;

    this.patchDigTime();
    this.setStatus('Farming');
    this.attackLoopActive = true;
    this.logger.info(`Starting farming loop attackInterval=${Math.max(150, Number(this.settings.attack_interval_ms) || 300)}ms reach=${Number(this.settings.farm_reach_blocks) || 4.5}`);
    this.runAttackLoop().catch((error) => {
      this.attackLoopActive = false;
      this.logger.warn('Attack loop failed', error);
    });
    return true;
  }

  stopAttack() {
    if (this.attackLoopActive || this.isDigging()) {
      this.logger.info(`Stopping attack loop active=${this.attackLoopActive} targetDigging=${this.isDigging()}`);
    }
    this.attackLoopActive = false;
    this.attackTimer = null;
    this.lastBrokenFarmPosKey = null;
    if (this.isDigging()) {
      try { this.bot.stopDigging(); } catch (e) {}
    }
  }

  async runAttackLoop() {
    // Жёстко фиксируем задержку как в minimal_bot.js (400мс)
    const tickDelay = 400;
    this.logger.info(`Attack loop entered tickDelay=${tickDelay}ms`);
    while (this.attackLoopActive && this.bot && !this.disconnectHandled) {
      await sleep(tickDelay);
      if (!this.attackLoopActive || !this.bot || this.disconnectHandled) break;
      await this.attackTick();
    }
    this.logger.info(`Attack loop exited active=${this.attackLoopActive} online=${Boolean(this.bot)} disconnectHandled=${this.disconnectHandled}`);
  }

  async attackTick() {
    if (!this.bot || !this.bot.entity || this.disconnectHandled) return;

    // Ищем сундук в радиусе 5 блоков (ТОЛЬКО сундуки, бочки, воронки)
    const chest = this.bot.findBlock({
      matching: (b) => b.name.includes('chest') || b.name.includes('barrel') || b.name.includes('hopper'),
      maxDistance: 5
    });

    if (!chest) return;

    try {
      // Сбрасываем зависшее копание, если оно застряло с прошлого раза
      if (this.bot.targetDigging) {
        this.bot.stopDigging();
      }

      // Обязательно машем рукой для античита
      if (typeof this.bot.swingArm === 'function') this.bot.swingArm('right');

      // bot.dig(блок, смотретьЛиНаБлок, типРейкаста) - строго как в minimal_bot.js (forceLook: true)
      await this.bot.dig(chest, true, 'raycast');

    } catch (err) {
      if (err.message !== 'Digging aborted' && err.message !== 'Block not in view') {
        this.logger.warn(`[Bot] Ошибка копания: ${err.message}`);
      }
    }
  }

  swingMainHand() {
    if (!this.bot) return;
    try {
      if (typeof this.bot.swingArm === 'function') this.bot.swingArm('right');
    } catch (error) {
      this.logThrottled('swing-hand-failed', `Swing hand failed: ${error.message || error}`, 10000);
    }
  }

  isDigging() {
    return Boolean(this.bot && (this.bot.targetDigBlock || this.bot.targetDigging));
  }

  getDigTarget() {
    return this.bot ? (this.bot.targetDigBlock || this.bot.targetDigging) : null;
  }

  stopDiggingIfNeeded(reason) {
    if (!this.isDigging()) return;
    this.logThrottled('stop-digging-cursor-lost', `Stopping dig: ${reason} target=${this.describeBlock(this.getDigTarget())}`, 3000);
    try {
      this.bot.stopDigging();
    } catch (error) {
      this.logger.warn(`stopDigging failed: ${error.message || error}`);
    }
  }

  isFarmTargetBlockName(name) {
    const normalized = String(name || '').toLowerCase();
    if (normalized === 'ender_chest') return false;
    return normalized.includes('chest') || normalized.includes('barrel') || normalized.includes('hopper');
  }

  logNearbyTargets(reach) {
    if (!this.bot || !this.bot.entity) return;
    const blocks = [];
    const maxDistance = Math.max(1, Math.ceil(reach));
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -maxDistance; dx <= maxDistance; dx++) {
        for (let dz = -maxDistance; dz <= maxDistance; dz++) {
          const pos = this.bot.entity.position.floored().offset(dx, dy, dz);
          const block = this.bot.blockAt(pos);
          if (!block) continue;
          if (!this.isFarmTargetBlockName(block.name)) continue;
          blocks.push(`${block.name}@${block.position.x},${block.position.y},${block.position.z}`);
        }
      }
    }

    const unique = [...new Set(blocks)].slice(0, 12);
    this.logThrottled(
      'nearby-targets',
      `Nearby target candidates count=${blocks.length} samples=${unique.join(' | ') || 'none'}`,
      10000
    );
  }

  describeBlock(block) {
    if (!block || !block.position) return 'none';
    const pos = block.position;
    return `${block.name || 'unknown'}@${pos.x},${pos.y},${pos.z}`;
  }

  blockPositionKey(position) {
    if (!position) return '';
    return `${position.x},${position.y},${position.z}`;
  }

  describeItem(item) {
    if (!item) return 'none';
    return `${item.displayName || item.customName || item.name || 'unknown'} x${item.count || 1}`;
  }

  getTargetBlockNames() {
    return Array.isArray(this.settings.target_block_names)
      ? this.settings.target_block_names.map((name) => String(name).trim().toLowerCase()).filter(Boolean)
      : [];
  }

  isAllowedAttackBlock(block) {
    if (!block || !block.position) return false;
    const targetNames = this.getTargetBlockNames();
    if (!targetNames.length) return true;
    return targetNames.includes(String(block.name || '').toLowerCase());
  }



  patchDigTime() {
    if (!this.bot || this.bot.__patchedDigTime) return;
    // Патч для бага 1.21: enchantments.concat is not a function при вызове digTime с топором.
    const origDigTime = this.bot.digTime.bind(this.bot);
    this.bot.digTime = (targetBlock) => {
      try { return origDigTime(targetBlock); } catch (e) { return 250; }
    };
    this.bot.__patchedDigTime = true;
  }

  logNoTargetDiagnostics(reach) {
    const entity = this.bot && this.bot.entity;
    const yaw = entity ? radiansToDegrees(entity.yaw).toFixed(1) : '-';
    const pitch = entity ? radiansToDegrees(entity.pitch).toFixed(1) : '-';
    const pos = entity && entity.position
      ? `${entity.position.x.toFixed(2)},${entity.position.y.toFixed(2)},${entity.position.z.toFixed(2)}`
      : '-';
    const cursorBlock = this.bot ? this.bot.blockAtCursor(Math.max(1, Number(reach) || 5)) : null;
    this.logThrottled(
      'no-target-block',
      `No target block found reach=${reach} yaw=${yaw} pitch=${pitch} pos=${pos} cursor=${this.describeBlock(cursorBlock)} held=${this.describeItem(this.bot && this.bot.heldItem)} targetDigging=${this.describeBlock(this.bot && this.bot.targetDigging)}`,
      15000
    );
  }

  logTargetBlock(block, target) {
    const now = Date.now();
    if (this.lastTargetLogAt + 15000 > now) return;
    this.lastTargetLogAt = now;
    let distance = '-';
    try {
      const center = block.position.offset(0.5, 0.5, 0.5);
      distance = this.bot.entity.position.distanceTo(center).toFixed(2);
    } catch (e) { distance = '-'; }
    const pos = target.position;
    const digMs = (() => { try { return Math.round(this.bot.digTime(block)); } catch (e) { return '?'; } })();
    this.logger.info(
      `Target block name=${target.name} coords=${pos.x},${pos.y},${pos.z} face=${target.face} distance=${distance} digTime=${digMs}ms sendArmAnimation=${this.settings.send_arm_animation !== false}`
    );
  }

  handleMessageString(message) {
    const text = stripMinecraftFormatting(message || '');
    const sender = parseTpaSender(text) || this.findWhitelistedTpaSender(text);
    if (sender && this.manager.isWhitelisted(sender)) {
      this.handleTpa(sender).catch((error) => this.logger.warn('TPA handler failed', error));
      return;
    }
    if (looksLikeTpaMessage(text)) {
      this.logThrottled(
        'tpa-message-ignored',
        `TPA-like message ignored: sender=${sender || '-'} whitelisted=${sender ? this.manager.isWhitelisted(sender) : false} text=${text.slice(0, 240)}`,
        10000
      );
    }
  }

  recordChatLine(direction, message) {
    const text = stripMinecraftFormatting(message || '').trim();
    if (!text) return;
    const entry = {
      at: Date.now(),
      direction: String(direction || 'IN').toUpperCase(),
      text: text.slice(0, 500)
    };
    this.chatLog.push(entry);
    if (this.chatLog.length > 120) this.chatLog.splice(0, this.chatLog.length - 120);
    appendMinecraftChatLog(this.botConfig.username, entry, this.logger);
  }

  getChatLog(limit = 30) {
    const count = Math.max(1, Math.min(80, Number(limit) || 30));
    const fileEntries = readMinecraftChatLog(this.botConfig.username, count, this.logger);
    if (fileEntries.length) return fileEntries;
    return this.chatLog.slice(-count);
  }

  sendConsoleChat(command) {
    this.recordChatLine('OUT', command);
    this.sendChat(command);
  }

  async handleTpa(sender) {
    if (this.tpaInProgress || !this.bot || this.disconnectHandled) return;
    this.tpaInProgress = true;
    try {
      const msg = `🤝 \`${this.displayName()}\` accepted TPA request from **${sender}**`;
      this.logger.info(`Accepted TPA workflow for ${sender}`);
      this.manager.dashboard?.sendLog(msg);
      this.stopAttack(true);
      this.setStatus('TPA Trade');
      this.sendChat(this.settings.home_trade_command);
      await sleep(Number(this.settings.teleport_wait_ms) || 1000);
      this.sendChat(`/tpaccept ${sender}`);
      await sleep(500);
      this.sendChat('/tpaccept');
      
      // Даем время на телепортацию
      this.setStatus('Waiting Return');
      await sleep(Number(this.settings.teleport_wait_ms) || 1000);

      this.sendChat(this.settings.home_farm_command);
      await sleep(Number(this.settings.teleport_wait_ms) || 1000);
    } finally {
      this.tpaInProgress = false;
      if (this.status === 'TPA Trade' || this.status === 'Waiting Return') this.setStatus('Ready');
      this.startFarming();
    }
  }

  findWhitelistedTpaSender(message) {
    if (!looksLikeTpaMessage(message)) return '';
    const text = String(message || '').toLowerCase();
    for (const username of this.config.whitelist || []) {
      const name = String(username || '').trim();
      if (!name) continue;
      const escaped = escapeRegExp(name.toLowerCase());
      if (new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(text)) return name;
    }
    return '';
  }



  sendChat(command) {
    if (!this.bot || !command) return;
    try {
      this.bot.chat(command);
    } catch (error) {
      this.logger.warn(`Failed to send chat command ${command}`, error.message || error);
    }
  }

  async handleWindowOpen(window) {
    if (!this.bot || !window) return;

    // Авто-подтверждение TPA GUI (DonutSMP)
    if (this.tpaInProgress && window.slots) {
      const confirmSlot = window.slots.find(item => item && (item.name.includes('lime_stained_glass_pane') || item.name.includes('green_stained_glass_pane')));
      if (confirmSlot) {
        this.logger.info(`Found TPA confirm GUI, clicking green button (slot ${confirmSlot.slot})`);
        try {
          await this.bot.clickWindow(confirmSlot.slot, 0, 0);
          this.bot.closeWindow(window);
          return;
        } catch (err) {
          this.logger.warn(`Failed to click TPA confirm button: ${err.message}`);
        }
      }
    }

    if (!this.config.server.exploit_protection) return;
    const type = String(window.type || '').toLowerCase();
    const title = normalizeText(window.title || window.name || '');
    const looksForced = type.includes('anvil') || title.includes('anvil') || title.includes('repair') || title.includes('smith');
    if (!looksForced) return;

    this.logThrottled('forced-window-open', `Forced GUI opened: ${type || 'unknown'} ${title || ''}`.trim(), 30000);
    try {
      if (typeof this.bot.closeWindow === 'function') this.bot.closeWindow(window);
    } catch (error) {
      this.logger.warn('Failed to close forced GUI window', error.message || error);
    }
  }
}

function faceFromBlock(block) {
  const face = block && block.face;
  if (Number.isInteger(face)) return face;
  if (typeof face === 'string') {
    const key = face.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(FACE, key)) return FACE[key];
  }
  if (face && typeof face === 'object') {
    if (face.y < 0) return FACE.bottom;
    if (face.y > 0) return FACE.top;
    if (face.z < 0) return FACE.north;
    if (face.z > 0) return FACE.south;
    if (face.x < 0) return FACE.west;
    if (face.x > 0) return FACE.east;
  }
  return FACE.top;
}

function radiansToDegrees(radians) {
  return (Number(radians) * 180) / Math.PI;
}

function normalizeRadians(radians) {
  let value = Number(radians) || 0;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

function formatDuration(durationMs) {
  let seconds = Math.max(0, Math.floor(Number(durationMs) / 1000));
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function isMicrosoftDeviceCodeExpired(lowerReason) {
  const text = String(lowerReason || '').toLowerCase();
  return text.includes('expired_token') && (
    text.includes('device_code') ||
    text.includes('device code') ||
    text.includes('code has expired')
  );
}

function parseTpaSender(message) {
  const text = stripMinecraftFormatting(message || '');
  const patterns = [
    /([A-Za-z0-9_]{1,16})\s+has requested to teleport to you/i,
    /([A-Za-z0-9_]{1,16})\s+wants to teleport to you/i,
    /([A-Za-z0-9_]{1,16})\s+sent you a teleport request/i,
    /([A-Za-z0-9_]{1,16})\s+sent you a tpa request/i,
    /teleport request from\s+([A-Za-z0-9_]{1,16})/i,
    /TPA\s*[:>»]\s*([A-Za-z0-9_]{1,16})/i,
    /\[?TPA\]?\s+([A-Za-z0-9_]{1,16})/i,
    /\/tpaccept\s+([A-Za-z0-9_]{1,16})/i,
    /([A-Za-z0-9_]{1,16}).{0,80}(?:\/tpaccept|accept)/i,
    /([A-Za-z0-9_]{1,16}).{0,80}(?:просит|хочет).{0,80}телепорт/i
  ];

  if (!looksLikeTpaMessage(text)) return '';
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function looksLikeTpaMessage(message) {
  return /teleport|tpa|tpaccept|телепорт/i.test(String(message || ''));
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendMinecraftChatLog(username, entry, logger) {
  try {
    const dir = minecraftChatLogDir();
    fs.mkdirSync(dir, { recursive: true });
    pruneOldMinecraftChatLogs(dir, logger);
    fs.appendFileSync(
      path.join(dir, minecraftChatLogFileName(username, new Date(entry.at || Date.now()))),
      `${JSON.stringify(entry)}\n`
    );
  } catch (error) {
    if (logger) logger.warn(`Failed to write Minecraft chat log: ${error.message || error}`);
  }
}

function readMinecraftChatLog(username, limit, logger) {
  try {
    const dir = minecraftChatLogDir();
    if (!fs.existsSync(dir)) return [];
    const prefix = `${safeLogName(username)}-`;
    const files = fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl'))
      .sort()
      .slice(-4);
    const entries = [];
    for (const file of files) {
      const filePath = path.join(dir, file);
      const text = readTail(filePath, 128 * 1024);
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          if (entry && entry.text) entries.push(entry);
        } catch (error) {}
      }
    }
    return entries.slice(-limit);
  } catch (error) {
    if (logger) logger.warn(`Failed to read Minecraft chat log: ${error.message || error}`);
    return [];
  }
}

function pruneOldMinecraftChatLogs(dir, logger) {
  const cutoff = Date.now() - (3 * 24 * 60 * 60 * 1000);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(dir, name);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
    }
  } catch (error) {
    if (logger) logger.warn(`Failed to prune Minecraft chat logs: ${error.message || error}`);
  }
}

function minecraftChatLogDir() {
  return path.join(process.cwd(), 'logs', 'minecraft-chat');
}

function minecraftChatLogFileName(username, date) {
  return `${safeLogName(username)}-${date.toISOString().slice(0, 10)}.jsonl`;
}

function safeLogName(value) {
  return String(value || 'unknown').replace(/[^a-z0-9_.@-]+/gi, '_').slice(0, 80) || 'unknown';
}

function readTail(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  const bytes = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, stat.size - bytes);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  BotController
};
