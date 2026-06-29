'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mineflayer = require('mineflayer');
const { createHttpAgent, createMineflayerConnect, getProxyLabel } = require('./proxy');
const {
  collectStrings,
  formatCompactMoney,
  formatMoney,
  normalizeMinecraftText,
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
  waitRestart: 'wait-restart',
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
const DEFAULT_CASHOUT_BALANCE_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const DEFAULT_HOME_RECOVERY_REPEAT_COOLDOWN_MS = 5 * 60 * 1000;

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
    this.spawnHomeInProgress = false;
    this.lastSpawnHomeAt = 0;
    this.lastMsaUserCode = '';
    this.lastMsaCodeAt = 0;
    this.announceNextLogin = Boolean(botConfig.announce_login_on_next_start);
    this.reconnectTimer = null;
    this.lastConnectionClosedAt = 0;
    this.spawnSessionInitialized = false;
    this.attackTimer = null;
    this.attackLoopActive = false;
    this.balanceTimer = null;
    this.axeTimer = null;
    this.axeRecoveryTimer = null;
    this.foodTimer = null;
    this.playerAlertTimer = null;
    this.farmRefreshTimer = null;
    this.farmRefreshInProgress = false;
    this.lastFarmRefreshAt = 0;
    this.homeRecoveryTimer = null;
    this.scheduledReconnectTimer = null;
    this.nextScheduledReconnectAt = 0;
    this.noAxeTickCount = 0;
    this.resumeFarmingAfterAxe = false;
    this.lastBrokenFarmPosKey = null;
    this.attackTargetCycleIndex = 0;
    this.lastTargetLogAt = 0;
    this.lastThrottleLog = new Map();
    this.lastMicrosoftAuthServiceAlertAt = 0;
    this.microsoftAuthServiceRetryAttempt = 0;
    this.lastPlayerAlertAt = new Map();
    this.proxyFailureTimes = [];
    this.chatLog = [];
    this.lastRecordedChatKey = '';
    this.lastRecordedChatAt = 0;
    this.tpaInProgress = false;
    this.pendingTpaSender = '';
    this.tpaAcceptedNotified = false;
    this.tpaAttemptNotified = false;
    this.tpaFailureNotified = false;
    this.pendingCashout = null;
    this.pendingGameBalances = new Map();
    this.pendingCashoutRetry = null;
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
    this.homeRecoveryExpectedRestartUntil = 0;
    this.homeRecoverySuppressStuckAlertUntil = 0;
    this.lastFarmActivityAt = 0;
    this.lastFarmTarget = null;
    this.homeRecoveryHomeCommandSentAt = 0;
    this.homeRecoveryFirstCommandAt = 0;
    this.homeRecoveryAttemptCount = 0;
    this.homeRecoveryStuckAfterHomeAlerted = false;
    this.homeRecoveryNextStartAllowedAt = 0;
    this.homeRecoveryChatLines = [];
    this.lastHomeRecoveryDiscordAt = new Map();
    
    this.sessionEarned = 0;
    this.sessionStartTime = Date.now();
    this.lastBalance = null;
    this.lastBalanceAt = 0;
    this.incomeLabel = '-';
    this.profitSamples = [];
    this.currentPerHour = 0;
    this.shortPerHour = 0;
    this.profitReady = false;
    this.lastProfitAlertAt = 0;
    this.profitAlertActive = false;
    this.profitAlertLowCount = 0;
    this.profitAlertLastEvaluatedSampleAt = 0;
    this.kickRetryAttempt = false;

  }

  start() {
    this.connect();
  }

  displayName() {
    const liveName = cleanProfileName(this.realUsername || (this.bot && this.bot.username));
    if (liveName) return liveName;
    return this.botConfig.nickname || this.botConfig.stats_username || this.botConfig.username;
  }

  statsUsername() {
    const liveName = cleanProfileName(this.realUsername || (this.bot && this.bot.username));
    return liveName || this.botConfig.stats_username || this.botConfig.nickname || this.botConfig.username;
  }

  rememberProfileName(name, source = 'profile') {
    const profileName = cleanProfileName(name);
    if (!profileName) return false;

    this.realUsername = profileName;
    let changed = false;
    if (this.botConfig.nickname !== profileName) {
      this.botConfig.nickname = profileName;
      changed = true;
    }
    if (this.botConfig.stats_username !== profileName) {
      this.botConfig.stats_username = profileName;
      changed = true;
    }

    const configBot = (this.config.bots || []).find((item) => item.username === this.botConfig.username);
    if (configBot) {
      if (configBot.nickname !== profileName) {
        configBot.nickname = profileName;
        changed = true;
      }
      if (configBot.stats_username !== profileName) {
        configBot.stats_username = profileName;
        changed = true;
      }
    }

    if (changed) {
      try {
        const { writeJsonFile } = require('./utils');
        writeJsonFile('config.json', this.config);
        this.logger.info(`Auto-saved in-game username from ${source}: ${this.botConfig.username} -> ${profileName}`);
      } catch (error) {
        this.logger.warn(`Failed to save in-game username from ${source}: ${error.message || error}`);
      }
    }

    return true;
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
      farm: this.farmSnapshot(),
      hunger: food,
      nextReconnectAt: this.nextScheduledReconnectAt || 0,
      online: Boolean(this.bot && !this.disconnectHandled && !this.userPaused && !this.pausedAuto),
      paused: this.userPaused || this.pausedAuto
    };
  }

  farmSnapshot() {
    const position = this.bot && this.bot.entity && this.bot.entity.position
      ? vectorSnapshot(this.bot.entity.position)
      : null;
    return {
      bot: position,
      target: this.lastFarmTarget || null
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

    const waitBeforeConnectMs = this.connectDelayRemainingMs();
    if (waitBeforeConnectMs > 0) {
      const seconds = Math.max(1, Math.ceil(waitBeforeConnectMs / 1000));
      this.setStatus(`Reconnect Wait (${seconds}s)`);
      this.logger.info(`Delaying connect for ${seconds}s after recent close/disconnect`);
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => this.connect(), waitBeforeConnectMs);
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
    this.spawnSessionInitialized = false;
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

    let microsoftAuthViaProxy = false;
    if (this.settings.proxy_microsoft_auth === true) {
      const proxyAgent = createHttpAgent(this.proxy);
      if (proxyAgent) {
        options.agent = proxyAgent;
        microsoftAuthViaProxy = true;
      }
    }
    const proxyConnect = createMineflayerConnect(this.proxy, server.host, server.port, this.logger);
    if (proxyConnect) options.connect = proxyConnect;

    try {
      this.logger.info(
        `Connecting as ${this.botConfig.username} to ${server.host}:${server.port} version=${options.version} proxy=${getProxyLabel(this.proxy)} mcConnect=${proxyConnect ? 'proxy' : 'direct'} msAuth=${microsoftAuthViaProxy ? 'proxy' : 'direct'}`
      );
      this.bot = mineflayer.createBot(options);
      this.attachBotEvents(this.bot);
    } catch (error) {
      this.logger.error('createBot failed', error);
      this.bot = null;
      this.scheduleReconnect('createBot failed');
    }
  }

  getReconnectPreConnectDelayMs() {
    const delay = Number(this.settings.reconnect_pre_connect_delay_ms);
    return Math.max(0, Number.isFinite(delay) ? delay : 5000);
  }

  connectDelayRemainingMs(now = Date.now()) {
    const delayMs = this.getReconnectPreConnectDelayMs();
    if (!delayMs || !this.lastConnectionClosedAt) return 0;
    return Math.max(0, this.lastConnectionClosedAt + delayMs - now);
  }

  attachBotEvents(bot) {
    if (bot._client && typeof bot._client.on === 'function') {
      bot._client.on('session', (session) => {
        const profileName = session && session.selectedProfile && session.selectedProfile.name;
        this.rememberProfileName(profileName || bot._client.username, 'session');
      });
    }

    bot.once('login', () => {
      this.rememberProfileName(bot.username, 'login');
      this.lastMsaUserCode = '';
      this.lastMsaCodeAt = 0;
      this.microsoftAuthServiceRetryAttempt = 0;
      this.kickRetryAttempt = false;
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
      const rawMsg = normalizeMinecraftText(args[0]).trim();
      const position = args[1] || '';
      this.recordChatLine('IN', rawMsg, position);
      const myName = this.bot ? this.bot.username : null;
      if (myName && rawMsg.includes(myName)) {
        this.lastChatWithMyName = rawMsg;
        this.lastChatWithMyNameTime = Date.now();
      }
      this.handleHomeRecoveryMessage(rawMsg);
      this.rememberHomeRecoveryChat(rawMsg, position);
      this.handleMessageString(rawMsg);
    });

    bot.on('message', (...args) => {
      const jsonMsg = args[0];
      const position = args[1] || '';
      const rawMsg = normalizeMinecraftText(jsonMsg, { maxDepth: 10, maxStrings: 80 }).trim();
      this.recordChatLine('IN', rawMsg, position);
      const myName = this.bot ? this.bot.username : null;
      if (myName && rawMsg.includes(myName)) {
        this.lastChatWithMyName = rawMsg;
        this.lastChatWithMyNameTime = Date.now();
      }
      this.handleHomeRecoveryMessage(rawMsg);
      this.rememberHomeRecoveryChat(rawMsg, position);
      this.handleMessageString(rawMsg);
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
          setTimeout(() => this.tryRecoverAxeAndFarming().catch(e => this.logger.warn(e)), 500);
        }
      }
    });

    bot.on('heldItemChanged', () => {
      this.handleHeldItemChanged();
    });

    bot.on('health', () => {
      this.autoEat('health').catch(err => this.logger.warn(`autoEat error: ${err.message}`));
    });
  }

  async onSpawn(bot) {
    if (bot !== this.bot) return;
    const isDeathRespawn = this.status === 'Dead / Respawning';
    if (this.spawnSessionInitialized && !isDeathRespawn) {
      this.markHomeRecoveryMovement();
      this.logThrottled('extra-spawn-event', `Ignoring extra spawn event while status=${this.status}`, 30000);
      return;
    }
    this.spawnSessionInitialized = true;
    this.disconnectHandled = false;
    this.phase = 'play';
    this.setStatus('Spawned');
    this.startFoodPolling();

    this.rememberProfileName(bot.username, 'spawn');
    await sleep(Number(this.settings.post_spawn_grace_ms) || 8000);
    if (bot !== this.bot || this.disconnectHandled) return;

    await this.returnHomeAfterSpawn();
    if (bot !== this.bot || this.disconnectHandled) return;

    this.startBalancePolling();
    this.startAxePolling();
    this.startHomeRecoveryPolling();
    this.startPlayerAlertPolling();
    this.scheduleScheduledReconnect();
    this.scheduleFarmRefresh();
    this.refreshBalance().catch((error) => this.logger.warn('Initial balance refresh failed', error));

    const ok = await this.checkAxe();
    if (ok) {
      await this.startFarming();
    }
    this.runPendingCashoutRetry('spawn').catch((error) => {
      this.logger.warn(`Cashout recovery retry failed: ${error.message || error}`);
    });
  }

  async returnHomeAfterSpawn() {
    if (this.settings.spawn_home_enabled === false) return;
    if (this.homeRecoveryExpectedRestartUntil && Date.now() < this.homeRecoveryExpectedRestartUntil) {
      this.logger.info('Spawn home skipped during expected server restart/update window');
      return;
    }
    const command = this.normalizedHomeCommand();
    if (!command) return;
    const now = Date.now();
    const cooldownMs = Math.max(0, Number(this.settings.spawn_home_cooldown_ms) || 30000);
    if (this.spawnHomeInProgress || (this.lastSpawnHomeAt && now - this.lastSpawnHomeAt < cooldownMs)) return;

    this.spawnHomeInProgress = true;
    this.lastSpawnHomeAt = now;
    try {
      this.setStatus('Spawn Home');
      this.logger.info(`Spawn home: sending ${command}`);
      this.sendChat(command);
      const waitMs = Math.max(
        1000,
        Number(this.settings.spawn_home_wait_ms) ||
          Number(this.settings.teleport_wait_ms) ||
          6500
      );
      await this.sendHomeCommandAndWait(command, waitMs, 'spawn home');
    } finally {
      this.spawnHomeInProgress = false;
    }
  }

  async sendHomeCommandAndWait(command, waitMs, context = 'home command') {
    if (!this.bot || !command) return false;
    const capturedChat = [];
    let confirmed = false;
    const listener = (...args) => {
      try {
        const rawText = normalizeMinecraftText(args[0], { maxDepth: 10, maxStrings: 80 }).trim();
        const chatKind = normalizeChatKind(args[1] || '');
        rememberHomeCommandChatLine(capturedChat, rawText, chatKind);
        if (isHomeTeleportSuccessMessage(rawText)) confirmed = true;
      } catch (error) {}
    };

    this.bot.on('message', listener);
    this.bot.on('messagestr', listener);
    try {
      this.sendChat(command);
      await sleep(Math.max(1000, Number(waitMs) || 6500));
    } finally {
      this.bot?.removeListener('message', listener);
      this.bot?.removeListener('messagestr', listener);
    }

    if (confirmed) {
      this.markHomeRecoveryMovement();
      return true;
    }

    this.notifyHomeCommandMissingConfirmation(command, context, capturedChat);
    return false;
  }

  notifyHomeCommandMissingConfirmation(command, context, chatLines = []) {
    const diagnostic = homeCommandDiagnosticSuffix(chatLines);
    const message = `Home command ${command} during ${context} did not confirm with "You teleported to your home".${diagnostic ? ` ${diagnostic}` : ' Minecraft chat: no useful lines captured.'}`;
    this.logger.warn(message);
    this.manager.dashboard?.sendLog(`⚠️ \`${this.displayName()}\` ${discordInline(message, 900)}`);
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
    return false;
  }

  async ensureFarmCameraLocked() {
    return false;
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
    this.lastConnectionClosedAt = Date.now();

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

    if (this.userPaused) {
      this.setStatus('Paused');
      return;
    }

    if (this.manualClose) {
      if (this.status !== 'Reconnecting') this.setStatus('Offline');
      return;
    }

    const suppressExpectedRestartDisconnect = this.shouldSuppressExpectedRestartDisconnect(classification, lowerReason);
    
    let isGhostSession = kind === 'kicked' && lowerReason.includes('already online');
    let isSecurity = kind === 'kicked' && classification.category === 'Server Security';
    let isBan = kind === 'kicked' && classification.category === 'Server Ban';
    let isTicket = kind === 'kicked' && (lowerReason.includes('make a ticket') || lowerReason.includes("don't know what happened"));
    let isMicrosoftAuthService = classification.category === 'Microsoft Auth Service';

    if (isBan) {
      this.handleServerBan(reasonText, classification);
      return;
    }

    let fastRetry = false;
    if ((kind === 'kicked' || kind === 'error') && !suppressExpectedRestartDisconnect && !isGhostSession && !isSecurity && !isTicket && !isMicrosoftAuthService) {
      if (!this.kickRetryAttempt) {
        fastRetry = true;
        this.kickRetryAttempt = true;
      }
    }

    if (!suppressExpectedRestartDisconnect && !fastRetry) {
      let emoji = '🔌';
      if (kind === 'kicked') emoji = '🚫';
      if (kind === 'error') emoji = '❌';
      const display = this.displayName();
      
      const isSpam = classification.category === 'Minecraft Profile' || classification.category === 'Minecraft Session';
      if (isMicrosoftAuthService) {
        this.notifyMicrosoftAuthServiceIssue(emoji, display, kind, reasonText, classification);
      } else if (!isSpam) {
        this.manager.dashboard?.sendLog(`${emoji} \`${display}\` disconnected. Kind: **${kind}** Category: **${classification.category}**\nReason: \`\`\`\n${classification.message}\n\`\`\`${this.disconnectDiagnosticSuffix(kind, reasonText, classification)}`);
      }
    }

    if (isGhostSession) {
      this.clearReconnectTimer();
      this.setStatus('Ghost Session / Wait 1m');
      this.logger.warn('Ghost session detected; auto-reconnecting in 1 minute');
      this.reconnectTimer = setTimeout(() => this.connect(), 60000);
      return;
    }

    if (isSecurity) {
      this.clearReconnectTimer();
      this.pausedAuto = true;
      this.setStatus('Server Security / Discord Verify');
      this.logger.warn('Server security kick detected; auto-reconnect paused until Discord verification is confirmed');
      return;
    }

    if (isTicket) {
      this.ticketRetryAt = Date.now() + (12 * 60 * 1000);
      this.clearReconnectTimer();
      this.setStatus('Server Ticket / Wait 12m');
      this.logger.warn('Ticket-style kick detected; auto-reconnecting in 12 minutes');
      this.reconnectTimer = setTimeout(() => this.connect(), 12 * 60 * 1000);
      return;
    }

    if (isMicrosoftAuthService) {
      this.scheduleMicrosoftAuthServiceReconnect(kind);
      return;
    }

    if (fastRetry) {
      this.clearReconnectTimer();
      this.setStatus('Fast Retry / Wait 10s');
      this.logger.warn('Fast retry: waiting 10 seconds before reconnecting to clear temporary kicks');
      this.reconnectTimer = setTimeout(() => this.connect(), 10000);
      return;
    }

    this.scheduleReconnect(kind);
  }

  shouldSuppressExpectedRestartDisconnect(classification, lowerReason) {
    if (!this.homeRecoveryExpectedRestartUntil || Date.now() > this.homeRecoveryExpectedRestartUntil) return false;
    const category = classification && classification.category;
    if (category === 'Network' || category === 'Proxy') return true;
    const lower = String(lowerReason || '').toLowerCase();
    return lower.includes('timed out') || lower.includes('timeout') || lower.includes('socketclosed') || lower.includes('econnreset');
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

  handleServerBan(reasonText, classification) {
    this.clearReconnectTimer();
    this.pausedAuto = true;
    this.userPaused = true;
    this.botConfig.enabled = false;
    this.botConfig.ban_locked = true;
    this.botConfig.disabled_reason = 'Server ban detected';
    this.botConfig.disabled_at = new Date().toISOString();

    const ban = parseServerBan(reasonText);
    if (ban.type) this.botConfig.ban_type = ban.type;
    if (ban.timeLeft) this.botConfig.ban_time_left = ban.timeLeft;
    if (ban.id) this.botConfig.ban_id = ban.id;

    try {
      const botConfig = (this.config.bots || []).find((bot) => bot.username === this.botConfig.username);
      if (botConfig) {
        botConfig.enabled = false;
        botConfig.ban_locked = true;
        botConfig.disabled_reason = this.botConfig.disabled_reason;
        botConfig.disabled_at = this.botConfig.disabled_at;
        if (ban.type) botConfig.ban_type = ban.type;
        if (ban.timeLeft) botConfig.ban_time_left = ban.timeLeft;
        if (ban.id) botConfig.ban_id = ban.id;
      }
      const { writeJsonFile } = require('./utils');
      writeJsonFile('config.json', this.config);
    } catch (error) {
      this.logger.warn(`Failed to persist ban lock: ${error.message || error}`);
    }

    this.setStatus('Banned / OFF');
    const fullReason = this.cleanDisconnectMessage(reasonText, 5000);
    const discordReason = this.cleanDisconnectMessage(reasonText, 1200);
    const detail = [
      `🚫 \`${this.displayName()}\` server ban detected. Bot was turned OFF and ban-locked.`,
      `Account: \`${discordInline(this.botConfig.username, 120)}\``,
      this.realUsername ? `Minecraft: \`${discordInline(this.realUsername, 32)}\`` : '',
      `Proxy: \`${discordInline(getProxyLabel(this.proxy), 120)}\``,
      ban.type ? `Ban type: \`${discordInline(ban.type, 40)}\`` : '',
      ban.timeLeft ? `Time left: \`${discordInline(ban.timeLeft, 80)}\`` : '',
      ban.id ? `Ban ID: \`${discordInline(ban.id, 40)}\`` : '',
      `Kind: **kicked** Category: **${classification.category}**`,
      `Reason:\n\`\`\`\n${discordReason}\n\`\`\``,
      this.disconnectDiagnosticSuffix('kicked', reasonText, classification)
    ].filter(Boolean).join('\n');

    this.logger.error(`Server ban locked bot=${this.displayName()} account=${this.botConfig.username} proxy=${getProxyLabel(this.proxy)} banType=${ban.type || '-'} timeLeft=${ban.timeLeft || '-'} banId=${ban.id || '-'} reason=${fullReason.replace(/\n/g, ' | ')}`);
    this.manager.dashboard?.sendLog(detail);
  }

  logProtocolDiagnostics(kind, reasonText) {
    const classification = this.classifyDisconnect(kind, reasonText);
    this.logger.warn(`Disconnected bot=${this.displayName()} kind=${kind} category=${classification.category} phase=${this.phase} reason=${classification.message}`);
  }

  disconnectDiagnosticSuffix(kind, reasonText, classification) {
    const lines = [
      `phase=${this.phase}`,
      `status=${this.status}`,
      `proxy=${getProxyLabel(this.proxy)}`,
      `mcUser=${this.bot && this.bot.username ? this.bot.username : '-'}`,
      `realUser=${this.realUsername || '-'}`,
      `manual=${Boolean(this.manualClose)}`,
      `userPaused=${Boolean(this.userPaused)}`,
      `pausedAuto=${Boolean(this.pausedAuto)}`,
      `reconnectOnKick=${this.settings.reconnect_on_kick !== false}`,
      `preConnectDelay=${this.getReconnectPreConnectDelayMs()}ms`
    ];
    if (this.lastMsaCodeAt) {
      lines.push(`lastMsaCode=${formatDuration(Date.now() - this.lastMsaCodeAt)} ago`);
    }
    const raw = this.cleanDisconnectMessage(reasonText, 700);
    if (raw && raw !== classification.message) lines.push(`raw=${raw.replace(/\n/g, ' | ')}`);
    if (classification.category === 'Minecraft Profile') {
      lines.push('note=Microsoft auth succeeded, but Mojang/Minecraft profile lookup failed. If the next login works, treat this as transient auth/profile-service failure.');
    }
    if (classification.category === 'Minecraft Session') {
      lines.push('note=Mojang session join failed before server login. If the next login works, treat this as transient Mojang/session/proxy failure.');
    }
    if (classification.category === 'Microsoft Auth Service') {
      lines.push('note=Microsoft/Xbox auth service failed before Minecraft login. This is usually transient; retrying with slower backoff.');
    }
    return `\nDiagnostics: \`${discordInline(lines.join(' | '), 900)}\``;
  }

  formatDisconnectReason(kind, reason) {
    return this.classifyDisconnect(kind, reason).message;
  }

  classifyDisconnect(kind, reason) {
    const text = normalizeMinecraftText(reason, { preserveNewlines: true }).trim();
    const lower = text.toLowerCase();
    if (!text) return { category: 'Unknown', message: 'No reason provided.' };

    if (lower === 'socketclosed' || lower.includes('socketclosed')) {
      return { category: 'Network', message: 'Network/server socket closed the connection.' };
    }
    if (lower.includes('econnreset')) {
      return { category: 'Network', message: 'Network connection was reset while contacting Minecraft/Mojang services.' };
    }
    if (lower.includes('sessionserver.mojang.com') || lower.includes('/session/minecraft/join') || lower.includes('minecraft/join')) {
      return { category: 'Minecraft Session', message: 'Mojang session join request failed before server login. This is usually transient network/proxy/sessionserver failure.' };
    }
    if (
      lower.includes('/authentication/login_with_xbox') ||
      lower.includes('login_with_xbox') ||
      (lower.includes('503 service unavailable') && (lower.includes('xbox') || lower.includes('microsoftauthflow') || lower.includes('prismarine-auth')))
    ) {
      return { category: 'Microsoft Auth Service', message: 'Microsoft/Xbox authentication service returned 503 before Minecraft login. This is usually transient; the bot will retry more slowly.' };
    }
    if (lower.includes('proxy') || lower.includes('socks') || lower.includes('connect timed out') || lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('ehostunreach')) {
      return { category: 'Proxy', message: 'Proxy connection failed or timed out.' };
    }
    if (lower.includes('failed to obtain profile data') && lower.includes('does the account own minecraft')) {
      return { category: 'Minecraft Profile', message: 'Microsoft account authenticated, but Minecraft Java profile lookup failed. This can be transient; if it repeats for the same account, check that the account owns Minecraft Java Edition.' };
    }
    if (isServerSecurityKick(kind, lower)) {
      return { category: 'Server Security', message: 'DonutSMP blocked this login as a possible unauthorized login. Confirm it with the button in this account Discord DMs, then turn the bot ON again.' };
    }
    if (isServerBanKick(kind, lower)) {
      return { category: 'Server Ban', message: this.cleanDisconnectMessage(text, 3000) };
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
      return { category: 'Server Kick', message: this.cleanDisconnectMessage(text, 1200) };
    }

    const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || text;
    const message = this.cleanDisconnectMessage(firstLine, 500);
    return { category: kind === 'error' ? 'Bot/Error' : 'Unknown', message };
  }

  cleanDisconnectMessage(text, maxLength = 500) {
    let message = normalizeMinecraftText(text, { preserveNewlines: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
    if (this.botConfig.username) {
      message = message.replace(new RegExp(escapeRegExp(this.botConfig.username), 'gi'), this.displayName());
    }
    return message.slice(0, Math.max(1, Number(maxLength) || 500));
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
    this.lastConnectionClosedAt = Date.now();
    this.spawnSessionInitialized = false;
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

  notifyMicrosoftAuthServiceIssue(emoji, display, kind, reasonText, classification) {
    const now = Date.now();
    const cooldownMs = Math.max(60 * 1000, Number(this.settings.microsoft_auth_service_alert_cooldown_ms) || 15 * 60 * 1000);
    if (this.lastMicrosoftAuthServiceAlertAt && now - this.lastMicrosoftAuthServiceAlertAt < cooldownMs) return;
    this.lastMicrosoftAuthServiceAlertAt = now;
    this.manager.dashboard?.sendLog(`${emoji} \`${display}\` disconnected. Kind: **${kind}** Category: **${classification.category}**\nReason: \`\`\`\n${classification.message}\n\`\`\`${this.disconnectDiagnosticSuffix(kind, reasonText, classification)}`);
  }

  scheduleMicrosoftAuthServiceReconnect(source) {
    if (this.userPaused || this.pausedAuto) return;
    this.clearReconnectTimer();
    const min = Math.max(60 * 1000, Number(this.settings.microsoft_auth_service_retry_min_ms) || 5 * 60 * 1000);
    const max = Math.max(min, Number(this.settings.microsoft_auth_service_retry_max_ms) || 30 * 60 * 1000);
    const attempt = Math.max(1, this.microsoftAuthServiceRetryAttempt + 1);
    this.microsoftAuthServiceRetryAttempt = attempt;
    const baseDelay = Math.min(max, min * Math.pow(2, attempt - 1));
    const jitter = randomInt(0, Math.max(1000, Math.floor(baseDelay * 0.2)));
    const delay = Math.min(max, baseDelay + jitter);
    this.setStatus(`Auth Service Retry (${Math.ceil(delay / 60000)}m)`);
    this.logger.warn(`Microsoft/Xbox auth service failure; scheduling reconnect in ${Math.round(delay / 1000)}s after ${source} attempt=${attempt}`);
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
    if (this.farmRefreshInProgress) return 'farm refresh';
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

  clearFarmRefreshTimer() {
    if (this.farmRefreshTimer) clearTimeout(this.farmRefreshTimer);
    this.farmRefreshTimer = null;
  }

  scheduleFarmRefresh(delayMs = null) {
    this.clearFarmRefreshTimer();
    if (this.settings.farm_refresh_enabled === false) return;
    if (this.userPaused || this.pausedAuto || this.disconnectHandled || !this.bot) return;

    const interval = Math.max(60 * 1000, Number(this.settings.farm_refresh_interval_ms) || 60 * 60 * 1000);
    const delay = Number.isFinite(Number(delayMs)) ? Math.max(1000, Number(delayMs)) : interval;
    this.farmRefreshTimer = setTimeout(() => {
      this.farmRefreshTimer = null;
      this.runFarmRefresh().catch((error) => {
        const detail = error && error.message ? error.message : String(error);
        this.logger.warn(`Farm refresh failed: ${detail}`);
        this.manager.dashboard?.sendLog(`⚠️ \`${this.displayName()}\` farm refresh failed: \`${discordInline(detail, 180)}\``);
      });
    }, delay);
  }

  farmRefreshBusyReason() {
    if (this.userPaused || this.pausedAuto || this.disconnectHandled || !this.bot) return 'offline/paused';
    if (this.farmRefreshInProgress) return 'already running';
    if (this.tpaInProgress) return 'TPA in progress';
    if (this.isEating) return 'eating';
    if (this.pendingCashout) return 'cashout in progress';
    if (this.homeRecoveryState !== HOME_RECOVERY.monitoring) return 'home recovery';
    if (this.status === 'TPA Trade' || this.status === 'Waiting Return') return this.status;
    if (this.status === 'Dead / Respawning') return this.status;
    return '';
  }

  async runFarmRefresh() {
    const interval = Math.max(60 * 1000, Number(this.settings.farm_refresh_interval_ms) || 60 * 60 * 1000);
    const minInterval = Math.max(
      60 * 1000,
      Number(this.settings.farm_refresh_min_interval_ms) || Math.min(interval, 55 * 60 * 1000)
    );
    if (this.lastFarmRefreshAt && Date.now() - this.lastFarmRefreshAt < minInterval) {
      const retryMs = Math.max(1000, this.lastFarmRefreshAt + minInterval - Date.now());
      this.scheduleFarmRefresh(retryMs);
      return false;
    }

    const busyReason = this.farmRefreshBusyReason();
    if (busyReason) {
      const retryMs = Math.max(60 * 1000, Number(this.settings.scheduled_reconnect_busy_retry_ms) || 5 * 60 * 1000);
      this.scheduleFarmRefresh(retryMs);
      return false;
    }

    const home2 = this.normalizedTradeHomeCommand();
    const home1 = this.normalizedHomeCommand();
    if (!home2 || !home1) {
      this.logger.warn('Farm refresh skipped: home_trade_command or home_farm_command missing');
      this.scheduleFarmRefresh();
      return false;
    }

    this.farmRefreshInProgress = true;
    this.lastFarmRefreshAt = Date.now();
    const wasFarming = this.attackLoopActive || this.status === 'Farming';
    try {
      this.stopAttack(true);
      this.closeCurrentWindow('before farm refresh');
      this.setStatus('Farm Refresh / Home 2');
      this.sendChat(home2);
      await sleep(Math.max(1000, Number(this.settings.farm_refresh_home2_wait_ms) || 6000));
      if (!this.bot || this.disconnectHandled || this.userPaused) return false;

      this.setStatus('Farm Refresh / Home 1');
      await this.sendHomeCommandAndWait(
        home1,
        Math.max(1000, Number(this.settings.farm_refresh_home1_wait_ms) || Number(this.settings.teleport_wait_ms) || 6500),
        'farm refresh home 1'
      );
      if (!this.bot || this.disconnectHandled || this.userPaused) return false;

      this.markHomeRecoveryMovement();
      if (wasFarming || this.settings.farming_enabled !== false) {
        await this.startFarming();
      }
      return true;
    } finally {
      this.farmRefreshInProgress = false;
      if (this.status === 'Farm Refresh / Home 2' || this.status === 'Farm Refresh / Home 1') this.setStatus('Ready');
      this.scheduleFarmRefresh();
    }
  }

  stopRuntime(sendCancel = true) {
    this.stopAttack(sendCancel);
    if (this.cameraTimer) clearInterval(this.cameraTimer);
    if (this.balanceTimer) clearInterval(this.balanceTimer);
    if (this.axeTimer) clearInterval(this.axeTimer);
    this.clearAxeRecoveryTimer();
    if (this.foodTimer) clearInterval(this.foodTimer);
    if (this.playerAlertTimer) clearInterval(this.playerAlertTimer);
    this.clearFarmRefreshTimer();
    if (this.homeRecoveryTimer) clearInterval(this.homeRecoveryTimer);
    this.clearScheduledReconnectTimer();
    this.cameraTimer = null;
    this.balanceTimer = null;
    this.axeTimer = null;
    this.foodTimer = null;
    this.playerAlertTimer = null;
    this.farmRefreshTimer = null;
    this.farmRefreshInProgress = false;
    this.spawnSessionInitialized = false;
    this.homeRecoveryTimer = null;
    this.pendingCashout = null;
    this.pendingGameBalances.clear();
    this.resumeFarmingAfterAxe = false;
    this.tpaInProgress = false;
    this.pendingTpaSender = '';
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
      this.reconnectTimer = setTimeout(() => this.connect(), this.getReconnectPreConnectDelayMs());
    });
  }

  recoverCommandChannel(reason) {
    if (!this.bot || this.disconnectHandled || this.userPaused) return false;
    const detail = String(reason || 'command channel did not respond').slice(0, 240);
    this.logger.warn(`Recovering command channel by reconnecting bot: ${detail}`);
    this.manager.dashboard?.sendLog(`♻️ \`${this.displayName()}\` reconnecting to recover stuck command channel. Reason: \`${discordInline(detail, 180)}\``);
    this.reconnectNow();
    return true;
  }

  queueCashoutRetryAfterReconnect(reason) {
    this.pendingCashoutRetry = {
      queuedAt: Date.now(),
      reason: String(reason || 'cashout unconfirmed').slice(0, 240)
    };
    this.logger.warn(`Queued cashout retry after reconnect: ${this.pendingCashoutRetry.reason}`);
  }

  async runPendingCashoutRetry(source) {
    const retry = this.pendingCashoutRetry;
    if (!retry || !this.bot || this.disconnectHandled || this.userPaused) return false;
    this.pendingCashoutRetry = null;

    const delayMs = Math.max(1000, Number(this.settings.cashout_reconnect_retry_delay_ms) || 5000);
    this.logger.warn(`Running queued cashout retry after ${source}; delay=${delayMs}ms reason=${retry.reason}`);
    await sleep(delayMs);
    if (!this.bot || this.disconnectHandled || this.userPaused) return false;

    return this.cashout({ recoveryRetry: true });
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

    this.clearFarmRefreshTimer();
    await this.prepareHomeBeforeDisconnect(reason);
    this.stopRuntime();
    this.forceClose();

    if (reason === 'Reconnecting') {
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => this.connect(), this.getReconnectPreConnectDelayMs());
    }
  }

  async prepareHomeBeforeDisconnect(reason = 'disconnect') {
    if (this.settings.disconnect_home_enabled === false) return false;
    if (!this.bot || this.disconnectHandled) return false;
    const command = this.normalizedTradeHomeCommand();
    if (!command) return false;

    try {
      this.logger.info(`Pre-disconnect home: sending ${command} before ${reason}`);
      this.stopAttack(true);
      this.closeCurrentWindow('before pre-disconnect home');
      this.setStatus('Pre-Disconnect Home');
      this.sendChat(command);
      const waitMs = Math.max(
        5000,
        Number(this.settings.disconnect_home_wait_ms) ||
          Number(this.settings.teleport_wait_ms) ||
          6500
      );
      await sleep(waitMs);
      return true;
    } catch (error) {
      this.logger.warn(`Pre-disconnect home failed: ${error.message || error}`);
      return false;
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

  clearAxeRecoveryTimer() {
    if (this.axeRecoveryTimer) clearTimeout(this.axeRecoveryTimer);
    this.axeRecoveryTimer = null;
  }

  scheduleAxeRecoveryCheck() {
    if (this.axeRecoveryTimer || !this.bot || this.disconnectHandled) return;
    const retryMs = Math.max(1000, Number(this.settings.axe_wait_retry_ms) || 5000);
    this.axeRecoveryTimer = setTimeout(() => {
      this.axeRecoveryTimer = null;
      this.tryRecoverAxeAndFarming().catch((error) => {
        this.logger.warn(`Axe recovery check failed: ${error.message || error}`);
        this.scheduleAxeRecoveryCheck();
      });
    }, retryMs);
  }

  async tryRecoverAxeAndFarming() {
    if (!this.bot || this.disconnectHandled || this.userPaused || this.pausedAuto) return false;
    const ok = await this.checkAxe();
    if (!ok) return false;
    if (!this.resumeFarmingAfterAxe || !this.canResumeFarmingAfterAxe()) return true;

    this.resumeFarmingAfterAxe = false;
    return this.startFarming();
  }

  canResumeFarmingAfterAxe() {
    if (this.settings.farming_enabled === false) return false;
    if (!this.bot || this.disconnectHandled || this.userPaused || this.pausedAuto) return false;
    if (this.tpaInProgress || this.isEating) return false;
    if (this.status === 'TPA Trade' || this.status === 'Waiting Return' || this.status === 'Dead / Respawning') return false;
    return this.homeRecoveryState === HOME_RECOVERY.monitoring;
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
      case HOME_RECOVERY.waitRestart:
        this.tickHomeRecoveryRestartWait(now);
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
    if (this.shouldIgnoreHomeRecoveryNoTargetGap(now)) {
      this.markHomeRecoveryMovement(now);
      return;
    }
    if (!this.canStartHomeRecovery(now)) {
      const waitMs = Math.max(0, this.homeRecoveryNextStartAllowedAt - now);
      this.logThrottled(
        'home-recovery-repeat-suppressed',
        `Home Recovery: repeated start suppressed for ${formatDuration(waitMs)} after recent recovery attempt`,
        30000
      );
      this.markHomeRecoveryMovement(now);
      return;
    }

    this.beginHomeRecoveryDelay(this.homeRecoveryInactivityReason(stuckMs));
  }

  tickHomeRecoveryServerReturn(now) {
    this.updateHomeRecoveryMovement(now);
    const reach = Math.max(1, Number(this.settings.farm_reach_blocks) || 4.5);
    if (!this.findAttackTargets(reach).length) return;
    if (this.homeRecoveryMaintenanceStartedAt > 0) {
      this.notifyHomeRecovery(`Server returned bot after ${formatDuration(now - this.homeRecoveryMaintenanceStartedAt)}.`, true);
    }
    this.finishHomeRecovery('server-return');
  }

  tickHomeRecoveryRestartWait(now) {
    this.updateHomeRecoveryMovement(now);
    const reach = Math.max(1, Number(this.settings.farm_reach_blocks) || 4.5);
    if (!this.findAttackTargets(reach).length) return;
    if (this.homeRecoveryMaintenanceStartedAt > 0) {
      this.notifyHomeRecovery(`Server returned bot after ${formatDuration(now - this.homeRecoveryMaintenanceStartedAt)}.`, true);
    }
    this.finishHomeRecovery('server-return');
  }

  shouldPauseHomeRecoveryMovementCheck() {
    if (this.userPaused || this.pausedAuto || this.tpaInProgress || this.isEating || this.pendingCashout) return true;
    if (this.farmRefreshInProgress) return true;
    if (this.status === 'TPA Trade' || this.status === 'Waiting Return') return true;
    if (this.status === 'Dead / Respawning') return true;
    if (this.status === 'Waiting Axe') return true;
    if (String(this.status || '').startsWith('Farm Refresh')) return true;
    return false;
  }

  getHomeRecoveryStuckMs() {
    const seconds = Number(this.settings.home_recovery_stuck_seconds);
    return Math.max(1, Number.isFinite(seconds) ? seconds : 10) * 1000;
  }

  getHomeRecoveryMoveThreshold() {
    const blocks = Number(this.settings.home_recovery_move_threshold_blocks);
    return Math.max(0.05, Number.isFinite(blocks) ? blocks : 0.2);
  }

  getHomeRecoveryDiscordCooldownMs() {
    const cooldown = Number(this.settings.home_recovery_discord_cooldown_ms);
    return Math.max(0, Number.isFinite(cooldown) ? cooldown : 10 * 60 * 1000);
  }

  getHomeRecoveryRepeatCooldownMs() {
    const cooldown = Number(this.settings.home_recovery_repeat_cooldown_ms);
    return Math.max(0, Number.isFinite(cooldown) ? cooldown : DEFAULT_HOME_RECOVERY_REPEAT_COOLDOWN_MS);
  }

  canStartHomeRecovery(now = Date.now()) {
    return !this.homeRecoveryNextStartAllowedAt || now >= this.homeRecoveryNextStartAllowedAt;
  }

  getRecentFarmActivityAt(now = Date.now()) {
    if (!this.lastFarmActivityAt) return 0;
    const graceMs = this.getHomeRecoveryStuckMs();
    return now - this.lastFarmActivityAt <= graceMs ? this.lastFarmActivityAt : 0;
  }

  shouldIgnorePassiveHomeRecoveryMovement() {
    if (this.settings.home_recovery_ignore_passive_movement === false) return false;
    return this.attackLoopActive || this.status === 'Farming';
  }

  shouldIgnoreHomeRecoveryNoTargetGap(now = Date.now()) {
    if (this.settings.home_recovery_ignore_no_target_farming === false) return false;
    if (!this.attackLoopActive && this.status !== 'Farming') return false;
    if (this.isDigging()) return false;
    if (!this.lastFarmTarget || !this.lastFarmTarget.at) return false;

    const graceMs = Math.max(1000, Number(this.settings.home_recovery_no_target_grace_ms) || 120000);
    if (now - this.lastFarmTarget.at > graceMs) return false;

    const reach = Math.max(1, Number(this.settings.farm_reach_blocks) || 4.5);
    const targets = this.findAttackTargets(reach);
    if (targets.length > 0) return false;

    const cursorBlock = this.bot ? this.bot.blockAtCursor(reach) : null;
    this.logThrottled(
      'home-recovery-no-target-gap',
      `Home Recovery: ignoring temporary farming no-target gap cursor=${this.describeBlock(cursorBlock)} lastTarget=${this.lastFarmTarget.name}@${this.lastFarmTarget.position.x},${this.lastFarmTarget.position.y},${this.lastFarmTarget.position.z} ${formatDuration(now - this.lastFarmTarget.at)} ago`,
      30000
    );
    return true;
  }

  homeRecoveryInactivityReason(stuckMs) {
    const seconds = Math.round(stuckMs / 1000);
    if (this.shouldIgnorePassiveHomeRecoveryMovement()) return `No farming activity for ${seconds}s`;
    return `No movement for ${seconds}s`;
  }

  markHomeRecoveryMovement(now = Date.now()) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return;
    this.homeRecoveryLastPosition = this.bot.entity.position.clone();
    this.homeRecoveryLastMovedAt = now;
  }

  updateHomeRecoveryMovement(now = Date.now()) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;
    const activityAt = this.getRecentFarmActivityAt(now);
    if (activityAt > 0) {
      this.markHomeRecoveryMovement(activityAt);
      return true;
    }
    if (this.shouldIgnorePassiveHomeRecoveryMovement()) return false;

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
    const now = Date.now();
    const delayMs = Math.max(0, Number(this.settings.home_recovery_first_home_delay_seconds) || 0) * 1000;
    const diagnostic = this.homeRecoveryDiagnosticLine(now);
    this.homeRecoveryState = HOME_RECOVERY.delayBeforeHome;
    this.homeRecoveryActionAt = now + delayMs;
    this.homeRecoveryNextStartAllowedAt = Math.max(
      this.homeRecoveryNextStartAllowedAt || 0,
      now + this.getHomeRecoveryRepeatCooldownMs()
    );
    this.stopAttack(true);
    this.setStatus('Home Recovery');
    this.notifyHomeRecovery(
      `${reason}. Sending ${this.normalizedHomeCommand()} in ${Math.round(delayMs / 1000)}s.${diagnostic ? ` diag: ${diagnostic}` : ''}`,
      true,
      { cooldownKey: 'start', cooldownMs: this.getHomeRecoveryDiscordCooldownMs() }
    );
  }

  tryHomeRecoveryTeleport() {
    const command = this.normalizedHomeCommand();
    if (!command) {
      this.scheduleHomeRecoveryRetry();
      return;
    }

    this.stopAttack(true);
    this.homeRecoveryChatLines = [];
    this.sendChat(command);
    this.homeRecoveryHomeCommandSentAt = Date.now();
    if (!this.homeRecoveryFirstCommandAt) this.homeRecoveryFirstCommandAt = this.homeRecoveryHomeCommandSentAt;
    this.homeRecoveryAttemptCount += 1;
    this.homeRecoveryState = HOME_RECOVERY.waitHomeResult;
    this.homeRecoveryActionAt = Date.now() + this.getHomeRecoveryCommandWaitMs();
    this.setStatus('Home Recovery / Waiting');
    this.notifyHomeRecovery(`Sent ${command}; waiting for home or maintenance chat. attempt=${this.homeRecoveryAttemptCount}`, false);
  }

  rememberHomeRecoveryChat(message, kind = '') {
    if (this.homeRecoveryState !== HOME_RECOVERY.waitHomeResult) return;
    rememberHomeCommandChatLine(this.homeRecoveryChatLines, message, kind);
  }

  getHomeRecoveryCommandWaitMs() {
    const seconds = Number(this.settings.home_recovery_command_wait_seconds);
    return Math.max(1, Number.isFinite(seconds) ? seconds : 8) * 1000;
  }

  scheduleHomeRecoveryRetry() {
    this.alertHomeRecoveryStillStuck();
    const minutes = this.nextHomeRecoveryRetryMinutes();
    const label = this.homeRecoveryMaintenanceStartedAt > 0 ? 'Maintenance Retry' : 'Home Retry';
    this.scheduleHomeRecoveryRetryIn(minutes, label, 'retry', this.homeRecoveryNoConfirmationDiagnostic());
  }

  scheduleHomeRecoveryRetryIn(minutes, label = 'Home Retry', cooldownKey = 'retry', diagnostic = '') {
    const retryMinutes = Math.max(1, Number(minutes) || 1);
    this.homeRecoveryState = HOME_RECOVERY.delayBeforeHome;
    this.homeRecoveryActionAt = Date.now() + retryMinutes * 60000;
    this.setStatus(`${label} (${retryMinutes}m)`);
    this.notifyHomeRecovery(
      `Next ${this.normalizedHomeCommand()} retry in ${retryMinutes} minute(s).${diagnostic ? ` ${diagnostic}` : ''}`,
      true,
      { cooldownKey, cooldownMs: this.getHomeRecoveryDiscordCooldownMs() }
    );
  }

  homeRecoveryNoConfirmationDiagnostic() {
    const diagnostic = homeCommandDiagnosticSuffix(this.homeRecoveryChatLines);
    return `No confirmation with "You teleported to your home".${diagnostic ? ` ${diagnostic}` : ' Minecraft chat: no useful lines captured.'}`;
  }

  alertHomeRecoveryStillStuck() {
    if (this.homeRecoveryStuckAfterHomeAlerted) return;
    if (this.homeRecoveryMaintenanceStartedAt > 0) return;
    if (this.homeRecoverySuppressStuckAlertUntil && Date.now() < this.homeRecoverySuppressStuckAlertUntil) return;
    if (!this.homeRecoveryHomeCommandSentAt) return;
    const minAttempts = Math.max(1, Number(this.settings.home_recovery_critical_after_attempts) || 3);
    if (this.homeRecoveryAttemptCount < minAttempts) {
      this.logger.warn(
        `Home Recovery: no confirmation after ${this.normalizedHomeCommand()} attempt ${this.homeRecoveryAttemptCount}/${minAttempts}; retrying without critical alert`
      );
      return;
    }
    this.homeRecoveryStuckAfterHomeAlerted = true;
    const stuckForMs = Date.now() - (this.homeRecoveryFirstCommandAt || this.homeRecoveryHomeCommandSentAt);
    this.manager.alertCritical(
      this,
      `Home Recovery: still stuck after ${this.normalizedHomeCommand()}; no recovery confirmed after ${formatDuration(stuckForMs)} and ${this.homeRecoveryAttemptCount} attempt(s). ${this.homeRecoveryNoConfirmationDiagnostic()}`
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
    const text = normalizeMinecraftText(message).trim();
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
      this.markHomeRecoveryExpectedRestart();
      this.enterHomeRecoveryRestartWait('Server updating; waiting without teleport.');
      this.logThrottled('home-recovery-server-updating', `Home Recovery: server update warning: ${text}`, 30000);
      return;
    }
    if (lower.includes(MAINTENANCE_MARKER)) {
      this.handleHomeRecoveryMaintenance(text);
      return;
    }
    if (isHomeTeleportSuccessMessage(lower)) {
      this.handleHomeRecoverySuccess(text);
    }
  }

  isHomeRecoveryProxyLimboMessage(lower) {
    return lower.includes(PROXY_LIMBO_MARKER) || (lower.includes(SERVER_RESTARTING_MARKER) && lower.includes('limbo'));
  }

  handleHomeRecoveryProxyLimbo(message) {
    this.homeRecoveryLastMessage = message;
    this.markHomeRecoveryExpectedRestart();
    if (this.homeRecoveryMaintenanceStartedAt <= 0) {
      this.homeRecoveryMaintenanceStartedAt = Date.now();
      this.notifyHomeRecovery(`Proxy limbo/restart detected: ${message}`, true);
    }
    this.enterHomeRecoveryRestartWait('Proxy limbo/restart; waiting without teleport.');
  }

  handleHomeRecoveryMaintenance(message) {
    this.homeRecoveryLastMessage = message;
    this.markHomeRecoveryExpectedRestart();
    if (this.homeRecoveryMaintenanceStartedAt <= 0) {
      this.homeRecoveryMaintenanceStartedAt = Date.now();
      this.notifyHomeRecovery(`Maintenance detected: ${message}`, true);
    }
    this.enterHomeRecoveryRestartWait('Maintenance detected; waiting without teleport.');
  }

  handleHomeRecoveryServerReturning(message) {
    this.homeRecoveryLastMessage = message;
    this.markHomeRecoveryExpectedRestart();
    if (this.homeRecoveryMaintenanceStartedAt <= 0) {
      this.homeRecoveryMaintenanceStartedAt = Date.now();
      this.notifyHomeRecovery(`Server return detected: ${message}`, true);
    }
    this.homeRecoveryState = HOME_RECOVERY.waitServerReturn;
    this.homeRecoveryActionAt = 0;
    this.markHomeRecoveryMovement();
    this.setStatus('Server Return Wait');
  }

  markHomeRecoveryExpectedRestart() {
    const silenceMs = Math.max(60 * 1000, Number(this.settings.home_recovery_restart_disconnect_silence_ms) || 15 * 60 * 1000);
    const until = Date.now() + silenceMs;
    this.homeRecoveryExpectedRestartUntil = Math.max(this.homeRecoveryExpectedRestartUntil || 0, until);
    this.homeRecoverySuppressStuckAlertUntil = Math.max(this.homeRecoverySuppressStuckAlertUntil || 0, until);
  }

  enterHomeRecoveryRestartWait(reason) {
    this.stopAttack(true);
    this.homeRecoveryState = HOME_RECOVERY.waitRestart;
    this.homeRecoveryActionAt = 0;
    this.homeRecoveryHomeCommandSentAt = 0;
    this.markHomeRecoveryMovement();
    this.setStatus('Restart Wait');
    this.logThrottled('home-recovery-restart-wait', `Home Recovery: ${reason}`, 30000);
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
    this.homeRecoveryFirstCommandAt = 0;
    this.homeRecoveryAttemptCount = 0;
    this.homeRecoveryStuckAfterHomeAlerted = false;
    this.homeRecoverySuppressStuckAlertUntil = 0;
    this.homeRecoveryExpectedRestartUntil = 0;
    this.homeRecoveryChatLines = [];
  }

  normalizedHomeCommand() {
    return String(this.settings.home_farm_command || '/home 1').trim();
  }

  normalizedTradeHomeCommand() {
    return String(this.settings.home_trade_command || '/home 2').trim();
  }

  notifyHomeRecovery(message, discord = false, options = {}) {
    const line = `Home Recovery: ${message}`;
    this.logger.warn(line);
    if (!discord) return;

    const cooldownKey = String(options.cooldownKey || '');
    const cooldownMs = Math.max(0, Number(options.cooldownMs) || 0);
    if (cooldownKey && cooldownMs > 0) {
      const now = Date.now();
      if ((this.lastHomeRecoveryDiscordAt.get(cooldownKey) || 0) + cooldownMs > now) return;
      this.lastHomeRecoveryDiscordAt.set(cooldownKey, now);
    }

    this.manager.dashboard?.sendLog(`🏠 \`${this.displayName()}\` ${line}`);
  }

  async refreshBalance() {
    const username = this.statsUsername();
    let result = await this.donutApi.getBalance(username, {
      botKey: this.botConfig.username,
      displayName: this.displayName()
    });

    if (isTransientBalanceApiError(result)) {
      const gameBalance = await this.getGameBalanceFallback(result);
      if (gameBalance && gameBalance.ok) result = gameBalance;
      else if (gameBalance) {
        result = {
          ...result,
          gameCode: gameBalance.code || '',
          chat: Array.isArray(gameBalance.chat) ? gameBalance.chat : []
        };
      }
    }

    if (!result) {
      result = { ok: false, code: 'NO_BALANCE', label: '-', balance: null };
    } else if (result.ok) {
      const suspiciousReason = this.suspiciousBalanceResultReason(result.balance);
      if (suspiciousReason) {
        this.logger.warn(
          `Ignored suspicious balance result for ${this.displayName()}: ${suspiciousReason}; value=${formatMoney(result.balance)} last=${formatMoney(this.lastBalance)}`
        );
        result = {
          ...result,
          ok: false,
          code: suspiciousReason,
          ignoredBalance: result.balance,
          balance: null,
          label: Number.isFinite(this.lastBalance) ? formatMoney(this.lastBalance) : '-'
        };
      } else {
        this.applyBalanceResult(result);
      }
    } else {
      const cachedLabel = this.cachedBalanceLabelForTransientError(result);
      if (cachedLabel) result = { ...result, label: cachedLabel, cachedLabel: true };
      else if (!result.label) result = { ...result, label: '-' };
    }
    
    this.balanceLabel = result.label;
    return result;
  }

  suspiciousBalanceResultReason(balance, now = Date.now()) {
    if (!Number.isFinite(balance)) return '';
    if (!Number.isFinite(this.lastBalance) || !this.lastBalanceAt) return '';
    if (this.pendingCashout || this.status === 'Cashout') return '';

    const elapsedMs = Math.max(1, now - this.lastBalanceAt);
    if (balance > this.lastBalance && this.isSuspiciousProfitDelta(balance - this.lastBalance, elapsedMs)) {
      return 'SUSPICIOUS_BALANCE_JUMP';
    }
    if (this.lastBalance > 1000000 && balance < this.lastBalance * 0.2 && elapsedMs <= this.balanceCacheMaxAgeMs()) {
      return 'SUSPICIOUS_BALANCE_DROP';
    }
    return '';
  }

  applyBalanceResult(result) {
    if (result.ok && Number.isFinite(result.balance)) {
      const now = Date.now();
      if (this.lastBalance === null) {
        // Первое измерение баланса (бот только зашел)
        this.sessionStartTime = now;
        this.profitSamples = [{ at: now, balance: result.balance }];
        this.resetProfitAlertState();
      } else if (result.balance > this.lastBalance) {
        const delta = result.balance - this.lastBalance;
        const elapsedMs = Math.max(1, now - (this.lastBalanceAt || now));
        if (this.isSuspiciousProfitDelta(delta, elapsedMs)) {
          this.resetProfitTracking(result.balance, now);
          this.logger.warn(
            `Ignored suspicious balance jump for profit stats: delta=$${formatCompactMoney(delta)} in ${formatDuration(elapsedMs)} balance=${formatMoney(result.balance)}`
          );
          return;
        }
        // Второе и последующие измерения
        this.sessionEarned += delta;
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
        this.resetProfitAlertState();
      } else {
        this.profitSamples.push({ at: now, balance: result.balance });
      }
      this.lastBalance = result.balance;
      this.lastBalanceAt = now;
      
      this.updateProfitMetrics(now);
      this.checkProfitAlert(now);
    }
  }

  isSuspiciousProfitDelta(delta, elapsedMs) {
    if (!Number.isFinite(delta) || delta <= 0) return false;
    const hours = Math.max(1 / 3600, Number(elapsedMs) / 3600000);
    const perHour = delta / hours;
    const reference = Math.max(1, Number(this.settings.profit_reference_per_hour) || 47500000);
    const threshold = Math.max(reference * 8, 250000000);
    return perHour > threshold;
  }

  resetProfitTracking(balance, now = Date.now()) {
    this.sessionStartTime = now;
    this.sessionEarned = 0;
    this.currentPerHour = 0;
    this.shortPerHour = 0;
    this.profitReady = false;
    this.profitSamples = [{ at: now, balance }];
    this.lastBalance = balance;
    this.lastBalanceAt = now;
    this.resetProfitAlertState();
    this.updateProfitMetrics(now);
  }

  async getGameBalanceFallback(apiResult) {
    return this.getGameBalance(this.statsUsername(), { apiResult });
  }

  async getGameBalance(username, options = {}) {
    if (!this.bot || this.disconnectHandled) return null;
    const command = this.gameBalanceCommand(username);
    if (!command) return null;
    const key = String(username || this.statsUsername() || '').trim().toLowerCase() || 'self';
    if (this.pendingGameBalances.has(key)) return this.pendingGameBalances.get(key);

    const waitMs = Math.max(1000, Number(this.settings.balance_command_wait_ms) || 5000);
    const startedAt = Date.now();
    const apiResult = options.apiResult || null;
    const capturedChat = [];
    const promise = new Promise((resolve) => {
      let settled = false;
      let timeoutId = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        this.bot?.removeListener('message', listener);
        this.bot?.removeListener('messagestr', listener);
        resolve(result);
      };
      const listener = (...args) => {
        try {
          const jsonMsg = args[0];
          const chatKind = normalizeChatKind(args[1] || '');
          if (chatKind === 'game_info') return;
          const rawText = normalizeMinecraftText(jsonMsg, { maxDepth: 10, maxStrings: 80 }).trim();
          rememberGameBalanceChatLine(capturedChat, rawText, chatKind);
          const balance = parseGameBalanceMessage(rawText, username);
          if (!Number.isFinite(balance)) return;
          finish({
            ok: true,
            code: 'GAME_BALANCE',
            label: formatMoney(balance),
            balance,
            source: 'game',
            username: String(username || ''),
            apiCode: apiResult && apiResult.code ? apiResult.code : '',
            chat: capturedChat.slice(-8)
          });
        } catch (error) {}
      };

      this.bot.on('message', listener);
      this.bot.on('messagestr', listener);
      this.sendChat(command);
      const reason = apiResult && apiResult.code ? ` after ${apiResult.code}` : '';
      this.logger.warn(`Requested in-game balance${reason}: ${command}`);
      timeoutId = setTimeout(() => {
        finish({
          ok: false,
          code: 'GAME_BALANCE_TIMEOUT',
          label: 'Game balance timeout',
          balance: null,
          source: 'game',
          username: String(username || ''),
          apiCode: apiResult && apiResult.code ? apiResult.code : '',
          elapsedMs: Date.now() - startedAt,
          chat: capturedChat.slice(-8)
        });
      }, waitMs);
    }).finally(() => {
      this.pendingGameBalances.delete(key);
    });

    this.pendingGameBalances.set(key, promise);
    const result = await promise;
    if (result.ok) {
      this.logger.info(`In-game balance ok target=${username || 'self'} balance=${formatMoney(result.balance)} sourceApi=${result.apiCode || '-'}`);
    } else {
      this.logger.warn(`In-game balance failed target=${username || 'self'} code=${result.code} sourceApi=${result.apiCode || '-'}${gameBalanceDiagnosticSuffix(result)}`);
    }
    return result;
  }

  gameBalanceCommand(username) {
    let base = String(this.settings.balance_command || '/balance').trim();
    if (base === '/bal') base = '/balance';
    if (!base) return '';
    const target = String(username || '').trim();
    if (!target || this.isOwnBalanceName(target)) return base;
    if (base.includes('{username}')) return base.replace(/\{username\}/g, target);
    return `${base} ${target}`;
  }

  isOwnBalanceName(username) {
    const target = String(username || '').trim().toLowerCase();
    if (!target) return true;
    const ownNames = [
      this.statsUsername(),
      this.displayName(),
      this.realUsername,
      this.bot && this.bot.username,
      this.botConfig.nickname,
      this.botConfig.stats_username,
      this.botConfig.username
    ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
    return ownNames.includes(target);
  }

  balanceCacheMaxAgeMs() {
    const configuredMaxAge = Number(this.settings.cashout_balance_cache_max_age_ms);
    return Number.isFinite(configuredMaxAge)
      ? Math.max(0, configuredMaxAge)
      : DEFAULT_CASHOUT_BALANCE_CACHE_MAX_AGE_MS;
  }

  cachedBalanceLabelForTransientError(result) {
    if (!isTransientBalanceApiError(result)) return '';
    const cachedAt = Number(this.lastBalanceAt) || 0;
    const ageMs = cachedAt ? Date.now() - cachedAt : Infinity;
    if (
      Number.isFinite(this.lastBalance) &&
      this.lastBalance >= 0 &&
      cachedAt > 0 &&
      ageMs <= this.balanceCacheMaxAgeMs()
    ) {
      return formatMoney(this.lastBalance);
    }
    return '';
  }

  cashoutBalanceFromResult(result) {
    if (result && result.ok && Number.isFinite(result.balance) && result.balance > 0) {
      return {
        balance: result.balance,
        source: result.source || 'balance',
        ageMs: 0,
        code: result.code || 'OK'
      };
    }
    if (!isTransientBalanceApiError(result)) return null;

    const cachedAt = Number(this.lastBalanceAt) || 0;
    const ageMs = cachedAt ? Date.now() - cachedAt : Infinity;
    if (
      Number.isFinite(this.lastBalance) &&
      this.lastBalance > 0 &&
      cachedAt > 0 &&
      ageMs <= this.balanceCacheMaxAgeMs()
    ) {
      return {
        balance: this.lastBalance,
        source: 'cache',
        ageMs,
        code: result && result.code ? result.code : ''
      };
    }

    return null;
  }

  recordCashoutAcceptedLocally(beforeBalance, amount) {
    const before = Number(beforeBalance);
    const paid = Number(amount);
    if (!Number.isFinite(before) || !Number.isFinite(paid) || paid <= 0) return;

    const now = Date.now();
    const after = Math.max(0, before - paid);
    this.lastBalance = after;
    this.lastBalanceAt = now;
    this.balanceLabel = formatMoney(after);
    this.sessionStartTime = now;
    this.sessionEarned = 0;
    this.currentPerHour = 0;
    this.shortPerHour = 0;
    this.profitReady = false;
    this.profitSamples = [{ at: now, balance: after }];
    this.resetProfitAlertState();
    this.updateProfitMetrics(now);
  }

  updateProfitMetrics(now = Date.now()) {
    const windowMs = Math.max(60 * 1000, Number(this.settings.profit_window_ms) || 5 * 60 * 1000);
    const warmupMs = Math.max(windowMs, Number(this.settings.profit_warmup_ms) || windowMs);
    const alertWindowMs = this.getProfitAlertWindowMs();
    const keepAfter = now - Math.max(windowMs * 3, alertWindowMs * 3, warmupMs + Math.max(windowMs, alertWindowMs));
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
    return this.calculateWindowStats(now, windowMs).perHour;
  }

  calculateWindowStats(now, windowMs) {
    if (!this.profitSamples.length) {
      return { perHour: 0, earned: 0, spanMs: 0, samples: 0, newestAt: 0 };
    }
    const newest = this.profitSamples[this.profitSamples.length - 1];
    let oldest = this.profitSamples[0];
    const cutoff = now - windowMs;
    for (const sample of this.profitSamples) {
      if (sample.at <= cutoff) oldest = sample;
      else break;
    }
    if (!oldest || newest.at <= oldest.at) {
      return { perHour: 0, earned: 0, spanMs: 0, samples: this.profitSamples.length, newestAt: newest ? newest.at : 0 };
    }
    const earned = newest.balance - oldest.balance;
    const spanMs = newest.at - oldest.at;
    const samples = this.profitSamples.filter((sample) => sample.at >= oldest.at && sample.at <= newest.at).length;
    return {
      perHour: earned > 0 ? earned / (spanMs / 3600000) : 0,
      earned: Math.max(0, earned),
      spanMs,
      samples,
      newestAt: newest.at
    };
  }

  getProfitAlertWindowMs() {
    const configured = Number(this.settings.profit_alert_window_ms);
    const displayWindow = Math.max(60 * 1000, Number(this.settings.profit_window_ms) || 5 * 60 * 1000);
    const balanceInterval = Math.max(60 * 1000, Number(this.settings.balance_interval_ms) || 5 * 60 * 1000);
    return Math.max(displayWindow, balanceInterval * 3, Number.isFinite(configured) ? configured : 20 * 60 * 1000);
  }

  resetProfitAlertState() {
    this.profitAlertActive = false;
    this.profitAlertLowCount = 0;
    this.profitAlertLastEvaluatedSampleAt = 0;
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
    if (this.settings.profit_alert_enabled === false) return;
    if (!this.profitReady) return;
    const cooldownMs = Math.max(60 * 1000, Number(this.settings.profit_alert_cooldown_ms) || 10 * 60 * 1000);

    const reference = this.manager.getProfitReferencePerHour(this);
    const dropPercent = Math.max(1, Number(this.settings.profit_alert_drop_percent) || 10);
    const threshold = reference * (1 - dropPercent / 100);
    if (!reference) return;

    const alertWindowMs = this.getProfitAlertWindowMs();
    const stats = this.calculateWindowStats(now, alertWindowMs);
    const minSamples = Math.max(2, Number(this.settings.profit_alert_min_samples) || 4);
    const minCoveragePercent = Math.max(10, Math.min(100, Number(this.settings.profit_alert_min_coverage_percent) || 70));
    const minSpanMs = alertWindowMs * (minCoveragePercent / 100);
    if (stats.samples < minSamples || stats.spanMs < minSpanMs) return;
    if (stats.newestAt && stats.newestAt === this.profitAlertLastEvaluatedSampleAt) return;
    this.profitAlertLastEvaluatedSampleAt = stats.newestAt || now;

    if (stats.perHour >= threshold) {
      this.profitAlertLowCount = 0;
      const recoveryThreshold = reference * (1 - dropPercent / 200);
      if (stats.perHour >= recoveryThreshold) this.profitAlertActive = false;
      return;
    }

    this.profitAlertLowCount += 1;
    if (this.profitAlertActive) return;
    const confirmations = Math.max(1, Number(this.settings.profit_alert_confirmations) || 2);
    if (this.profitAlertLowCount < confirmations) return;
    if (this.lastProfitAlertAt + cooldownMs > now) return;

    this.profitAlertActive = true;
    this.lastProfitAlertAt = now;
    const percent = Math.round((1 - (stats.perHour / reference)) * 100);
    this.logger.warn(`Profit alert: alertWindow=${formatDuration(alertWindowMs)} rate=${formatCompactMoney(stats.perHour)}/h reference=${formatCompactMoney(reference)}/h samples=${stats.samples}`);
    if (typeof this.manager.queueProfitAlert === 'function') {
      this.manager.queueProfitAlert(this, {
        shortPerHour: stats.perHour,
        reference,
        percent,
        windowMs: alertWindowMs,
        earned: stats.earned,
        samples: stats.samples
      });
    } else {
      const msg = [
        `📉 \`${this.displayName()}\` sales dropped.`,
        `Now: \`$${formatCompactMoney(stats.perHour)}/h\``,
        `Reference: \`$${formatCompactMoney(reference)}/h\``,
        `Window: \`${formatDuration(alertWindowMs)}\``,
        `Drop: \`${percent}%\``
      ].join(' ');
      this.manager.dashboard?.sendLog(msg);
    }
  }

  async cashout(options = {}) {
    if (!this.bot || this.disconnectHandled) return false;
    const isRecoveryRetry = Boolean(options.recoveryRetry);
    if (this.pendingCashout) {
      this.logger.warn('Cashout skipped: another cashout is already in progress');
      return false;
    }
    const balanceResult = await this.refreshBalance();
    const before = this.cashoutBalanceFromResult(balanceResult);
    if (!before) {
      const reason = balanceResult && balanceResult.code
        ? `balance unavailable (${balanceResult.code}) and no fresh cached balance`
        : 'balance unavailable and no fresh cached balance';
      const chatDetail = balanceResult && Array.isArray(balanceResult.chat)
        ? gameBalanceDiscordDiagnostic(balanceResult)
        : '';
      this.logger.warn(`Cashout skipped: ${reason}${gameBalanceDiagnosticSuffix(balanceResult)}`);
      this.manager.dashboard?.sendLog(`⚠️ \`${this.displayName()}\` cashout skipped. Reason: \`${discordInline(`${reason}${chatDetail ? ` ${chatDetail}` : ''}`, 700)}\``);
      return false;
    }
    const cashoutNickname = String(this.config.cashout_nickname || '').trim();
    if (!cashoutNickname) {
      this.logger.warn('cashout_nickname is not configured');
      return false;
    }
    
    const amount = Math.floor(before.balance);
    if (amount <= 0) return false;
    if (before.source === 'cache') {
      const reason = before.code ? `API ${before.code}` : 'API unavailable';
      const age = formatDuration(before.ageMs);
      this.logger.warn(`Cashout using cached balance because ${reason}; cachedAge=${age} amount=${amount}`);
      this.manager.dashboard?.sendLog(`⚠️ \`${this.displayName()}\` ${reason}; using cached balance from \`${age}\` ago for cashout.`);
    }

    const payment = {
      success: false,
      error: false,
      message: '',
      replies: [],
      chat: [],
      target: cashoutNickname,
      amount,
      startedAt: Date.now()
    };

    const replyListener = (...args) => {
      try {
        const jsonMsg = args[0];
        const chatKind = normalizeChatKind(args[1] || '');
        const rawText = normalizeMinecraftText(jsonMsg, { maxDepth: 10 }).trim();
        rememberCashoutChat(payment, rawText, chatKind);
        const classified = classifyCashoutReply(rawText, cashoutNickname, payment.amount || amount);
        if (!classified) return;
        rememberCashoutReply(payment, classified.message || rawText);
        if (classified.type === 'success') payment.success = true;
        if (classified.type === 'error') payment.error = true;
        payment.message = classified.message;
      } catch(e) {}
    };

    const wasFarming = this.attackLoopActive || this.status === 'Farming';
    this.pendingCashout = payment;
    this.bot.on('message', replyListener);
    this.bot.on('messagestr', replyListener);
    try {
      this.stopAttack(true);
      const replyWaitMs = Math.max(1000, Number(this.settings.cashout_reply_wait_ms) || 5000);
      const chunks = this.cashoutPaymentPlan(amount);
      const chunkDelayMs = this.cashoutChunkDelayMs();
      let acceptedChunks = 0;
      const shouldTryFullAmountFirst = chunks.length > 1;

      if (shouldTryFullAmountFirst) {
        this.logger.warn(
          `Cashout trying full amount first: total=${amount}; fallbackChunks=${chunks.length} maxChunk=${this.cashoutMaxSinglePaymentAmount()} chunkDelay=${chunkDelayMs}ms`
        );
        const fullAmountSent = await this.sendCashoutPaymentWithRetry(payment, cashoutNickname, amount, {
          replyWaitMs,
          isRecoveryRetry,
          index: 0,
          totalChunks: 1,
          balanceSource: before.source,
          temporaryRetry: false
        });

        if (fullAmountSent) {
          const verified = await this.verifyCashoutBalanceDrop(before.balance, amount);
          if (verified.ok) {
            this.logger.info(`Cashout confirmed amount=${amount} target=${cashoutNickname} ${verified.reason}`);
            return true;
          }

          if (payment.error) {
            const reason = payment.message || 'server rejected payment';
            this.logger.warn(`Cashout rejected during verification: ${reason}`);
            this.closeCurrentWindow('after failed cashout');
            this.manager.dashboard?.sendLog(`❌ \`${this.displayName()}\` failed to cashout **$${amount.toLocaleString('en-US')}** to \`${cashoutNickname}\`. Reason: \`${discordInline(reason, 180)}\`${this.cashoutDiagnosticSuffix(payment)}`);
            return false;
          }

          if (payment.success) {
            this.logger.info(`Cashout accepted by server amount=${amount} target=${cashoutNickname}${payment.message ? ` reply=${payment.message.slice(0, 160)}` : ''}`);
            this.recordCashoutAcceptedLocally(before.balance, amount);
            return true;
          }

          const lastBalance = Number.isFinite(verified.balance) ? `$${formatCompactMoney(verified.balance)}` : 'unknown';
          const reason = this.cashoutFailureReason(payment, verified);
          this.logger.warn(`Cashout unconfirmed amount=${amount} target=${cashoutNickname} balanceBefore=${before.balance} balanceAfter=${lastBalance} reason=${reason}`);
          this.closeCurrentWindow('after unconfirmed cashout');
          this.manager.dashboard?.sendLog(
            `⚠️ \`${this.displayName()}\` cashout to \`${cashoutNickname}\` is **not confirmed**. Tried: **$${amount.toLocaleString('en-US')}**. Balance now: \`${lastBalance}\`. Reason: \`${discordInline(reason, 220)}\`${this.cashoutDiagnosticSuffix(payment)}`
          );
          return false;
        }

        const reason = payment.message || latestCashoutChatReason(payment) || 'server rejected full payment';
        this.logger.warn(`Cashout full amount rejected amount=${amount}; falling back to ${chunks.length} chunks max=${this.cashoutMaxSinglePaymentAmount()}: ${reason}`);
        this.manager.dashboard?.sendLog(
          `⚠️ \`${this.displayName()}\` full cashout **$${amount.toLocaleString('en-US')}** was rejected; trying chunks up to **$${this.cashoutMaxSinglePaymentAmount().toLocaleString('en-US')}**. Reason: \`${discordInline(reason, 180)}\`${this.cashoutDiagnosticSuffix(payment)}`
        );
        acceptedChunks = 0;
      }

      for (let index = 0; index < chunks.length; index += 1) {
        const chunkAmount = chunks[index];
        const sent = await this.sendCashoutPaymentWithRetry(payment, cashoutNickname, chunkAmount, {
          replyWaitMs,
          isRecoveryRetry,
          index,
          totalChunks: chunks.length,
          balanceSource: before.source
        });
        if (!sent) {
          const reason = payment.message || latestCashoutChatReason(payment) || 'server rejected payment';
          this.logger.warn(`Cashout rejected chunk=${index + 1}/${chunks.length} amount=${chunkAmount}: ${reason}`);
          this.closeCurrentWindow('after rejected cashout');
          this.manager.dashboard?.sendLog(
            `❌ \`${this.displayName()}\` failed to cashout **$${amount.toLocaleString('en-US')}** to \`${cashoutNickname}\`. ` +
            `Chunk: **${index + 1}/${chunks.length}** (**$${chunkAmount.toLocaleString('en-US')}**). Reason: \`${discordInline(reason, 180)}\`${this.cashoutDiagnosticSuffix(payment)}`
          );
          return false;
        }

        if (payment.success) acceptedChunks += 1;
        if (index < chunks.length - 1 && chunkDelayMs > 0) {
          this.setStatus(`Cashout Wait (${Math.round(chunkDelayMs / 1000)}s)`);
          await sleep(chunkDelayMs);
        }
      }

      const verified = await this.verifyCashoutBalanceDrop(before.balance, amount);
      if (verified.ok) {
        this.logger.info(`Cashout confirmed amount=${amount} target=${cashoutNickname} ${verified.reason}`);
        return true;
      }

      if (payment.error) {
        const reason = payment.message || 'server rejected payment';
        this.logger.warn(`Cashout rejected during verification: ${reason}`);
        this.closeCurrentWindow('after failed cashout');
        this.manager.dashboard?.sendLog(`❌ \`${this.displayName()}\` failed to cashout **$${amount.toLocaleString('en-US')}** to \`${cashoutNickname}\`. Reason: \`${discordInline(reason, 180)}\`${this.cashoutDiagnosticSuffix(payment)}`);
        return false;
      }

      if (acceptedChunks === chunks.length) {
        this.logger.info(`Cashout accepted by server amount=${amount} target=${cashoutNickname} chunks=${chunks.length}${payment.message ? ` reply=${payment.message.slice(0, 160)}` : ''}`);
        this.recordCashoutAcceptedLocally(before.balance, amount);
        return true;
      }

      const lastBalance = Number.isFinite(verified.balance) ? `$${formatCompactMoney(verified.balance)}` : 'unknown';
      const reason = this.cashoutFailureReason(payment, verified);
      this.logger.warn(`Cashout unconfirmed amount=${amount} target=${cashoutNickname} balanceBefore=${before.balance} balanceAfter=${lastBalance} reason=${reason}`);
      this.closeCurrentWindow('after unconfirmed cashout');
      this.manager.dashboard?.sendLog(
        `⚠️ \`${this.displayName()}\` cashout to \`${cashoutNickname}\` is **not confirmed**. Tried: **$${amount.toLocaleString('en-US')}**. Balance now: \`${lastBalance}\`. Reason: \`${discordInline(reason, 220)}\`${this.cashoutDiagnosticSuffix(payment)}`
      );
      return false;
    } finally {
      this.bot?.removeListener('message', replyListener);
      this.bot?.removeListener('messagestr', replyListener);
      if (this.pendingCashout === payment) this.pendingCashout = null;
      if (String(this.status || '').startsWith('Cashout')) this.setStatus('Ready');
      if (wasFarming && this.bot && !this.disconnectHandled && !this.tpaInProgress) {
        this.startFarming().catch((error) => this.logger.warn(`Failed to restart farming after cashout: ${error.message || error}`));
      }
    }
  }

  async sendCashoutPaymentWithRetry(payment, target, amount, options = {}) {
    const replyWaitMs = Math.max(1000, Number(options.replyWaitMs) || Number(this.settings.cashout_reply_wait_ms) || 5000);
    const configuredRetryDelayMs = Number(this.settings.cashout_temporary_retry_delay_ms);
    const retryDelayMs = Number.isFinite(configuredRetryDelayMs) ? Math.max(0, Math.floor(configuredRetryDelayMs)) : 0;
    const index = Number(options.index) || 0;
    const totalChunks = Math.max(1, Number(options.totalChunks) || 1);
    const chunkLabel = totalChunks > 1 ? ` ${index + 1}/${totalChunks}` : '';
    const temporaryRetry = options.temporaryRetry !== false;

    const sendOnce = async (retry = false) => {
      resetCashoutPaymentForRetry(payment);
      payment.target = target;
      payment.amount = amount;
      payment.startedAt = Date.now();
      this.setStatus(retry ? `Cashout Retry${chunkLabel}` : `Cashout${chunkLabel}`);
      this.closeCurrentWindow(retry ? 'before cashout retry' : 'before cashout');
      this.sendChat(`/pay ${target} ${amount}`);
      this.logger.info(
        `Cashout ${retry ? 'retry ' : ''}sent: /pay ${target} ${amount}${chunkLabel}${options.isRecoveryRetry ? ' (recovery retry)' : ''} balanceSource=${options.balanceSource || '-'}`
      );
      await sleep(replyWaitMs);
    };

    await sendOnce(false);
    if (payment.error && temporaryRetry && isTemporaryCashoutFailure(payment.message) && !options.isRecoveryRetry) {
      const reason = payment.message || 'server refused this payment amount';
      this.logger.warn(`Cashout payment refused; retrying ${retryDelayMs > 0 ? `in ${Math.round(retryDelayMs / 1000)}s` : 'now'} amount=${amount}: ${reason}`);
      this.closeCurrentWindow('after temporary cashout error');
      this.manager.dashboard?.sendLog(
        `⚠️ \`${this.displayName()}\` cashout payment **$${amount.toLocaleString('en-US')}** was refused; retrying ${retryDelayMs > 0 ? `in **${Math.round(retryDelayMs / 1000)}s**` : '**now**'}. Reason: \`${discordInline(reason, 180)}\`${this.cashoutDiagnosticSuffix(payment)}`
      );
      if (retryDelayMs > 0) {
        this.setStatus(`Cashout Retry Wait (${Math.round(retryDelayMs / 1000)}s)`);
        await sleep(retryDelayMs);
      }
      if (!this.bot || this.disconnectHandled || this.userPaused) return false;
      await sendOnce(true);
    }

    return !payment.error;
  }

  cashoutPaymentPlan(amount) {
    const total = Math.max(0, Math.floor(Number(amount) || 0));
    if (total <= 0) return [];
    const maxSingle = this.cashoutMaxSinglePaymentAmount();
    if (!Number.isFinite(maxSingle) || maxSingle <= 0 || total <= maxSingle) return [total];

    const chunks = [];
    let remaining = total;
    while (remaining > 0) {
      const chunk = Math.min(maxSingle, remaining);
      chunks.push(chunk);
      remaining -= chunk;
    }
    return chunks;
  }

  cashoutMaxSinglePaymentAmount() {
    const hardMax = 10000000;
    const value = Number(this.settings.cashout_max_single_payment_amount);
    if (!Number.isFinite(value)) return hardMax;
    if (value <= 0) return hardMax;
    return Math.min(hardMax, Math.max(1, Math.floor(value)));
  }

  cashoutChunkDelayMs() {
    const value = Number(this.settings.cashout_chunk_delay_ms);
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
  }

  async verifyCashoutBalanceDrop(beforeBalance, amount) {
    const attempts = Math.max(1, Number(this.settings.cashout_verify_attempts) || 6);
    const intervalMs = Math.max(1000, Number(this.settings.cashout_verify_interval_ms) || 5000);
    const minDropRatio = Math.max(0.1, Math.min(1, Number(this.settings.cashout_verify_min_drop_ratio) || 0.8));
    const requiredDrop = Math.max(1, amount * minDropRatio);
    let lastBalance = null;
    let lastCode = '';

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) await sleep(intervalMs);
      const result = await this.refreshBalance();
      lastCode = result.code || '';
      if (!result.ok || !Number.isFinite(result.balance)) continue;
      lastBalance = result.balance;
      const drop = beforeBalance - result.balance;
      if (drop >= requiredDrop) {
        return {
          ok: true,
          balance: result.balance,
          reason: `balance drop $${formatCompactMoney(drop)}`
        };
      }
    }

    const drop = Number.isFinite(lastBalance) ? beforeBalance - lastBalance : 0;
    return {
      ok: false,
      balance: lastBalance,
      reason: Number.isFinite(lastBalance)
        ? `balance drop only $${formatCompactMoney(Math.max(0, drop))}; required $${formatCompactMoney(requiredDrop)}`
        : `balance verification unavailable${lastCode ? ` (${lastCode})` : ''}`
    };
  }

  cashoutFailureReason(payment, verified) {
    const chatReason = latestCashoutChatReason(payment);
    const verifyReason = verified && verified.reason ? String(verified.reason) : '';
    if (chatReason && verifyReason) return `${chatReason}; ${verifyReason}`;
    if (chatReason) return chatReason;
    if (verifyReason) return `Minecraft chat did not show a payment error; ${verifyReason}`;
    return 'Minecraft chat did not show a payment error and balance did not confirm the transfer';
  }

  cashoutDiagnosticSuffix(payment) {
    if (!payment) return '';
    const lines = [];
    for (const reply of payment.replies || []) {
      if (!shouldShowMinecraftChatLine({ direction: 'IN', text: reply, kind: 'system' })) continue;
      lines.push(reply);
    }
    for (const text of payment.chat || []) {
      if (!shouldShowMinecraftChatLine({ direction: 'IN', text, kind: 'system' })) continue;
      if (!lines.includes(text)) lines.push(text);
    }
    const startedAt = Number(payment.startedAt) || Date.now();
    for (const entry of this.chatLog.slice(-12)) {
      if (!entry || !entry.text || entry.at < startedAt - 2000) continue;
      if (!shouldShowMinecraftChatLine(entry)) continue;
      const line = `${entry.direction}: ${entry.text}`;
      if (!lines.includes(line)) lines.push(line);
    }

    const shown = lines
      .map((line) => discordInline(line, 180))
      .filter(Boolean)
      .slice(-5);

    const parts = [];
    if (shown.length) parts.push(`Chat: ${shown.map((line) => `\`${line}\``).join(' | ')}`);
    return parts.length ? `\n${parts.join('\n')}` : '';
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
    this.clearAxeRecoveryTimer();
    if (this.status === 'Waiting Axe') this.setStatus('Ready');
    return true;
  }

  handleHeldItemChanged() {
    if (!this.attackLoopActive || !this.bot || this.disconnectHandled || this.isEating) return;
    const held = this.bot.heldItem;
    if (this.matchesAxe(held)) {
      const result = this.inspectAxe(held);
      if (result.ok) return;
      this.stopDiggingIfNeeded(result.reason || 'axe expired');
    } else {
      this.stopDiggingIfNeeded('held item is not axe');
    }

    this.checkAxe().catch((error) => {
      this.logger.warn(`Held item axe recovery failed: ${error.message || error}`);
      this.handleAxeUnavailable('axe check failed');
    });
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
    let heldFailure = '';
    if (this.matchesAxe(held)) {
      const heldResult = this.inspectAxe(held);
      if (heldResult.ok) return heldResult;
      heldFailure = heldResult.reason || 'axe unavailable';
    }

    const item = this.findUsableAxeItem();
    if (!item) return { ok: false, reason: heldFailure || 'axe missing' };

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
    const shouldResume = this.resumeFarmingAfterAxe || this.attackLoopActive || this.status === 'Farming' || this.status === 'Waiting Axe';
    this.resumeFarmingAfterAxe = shouldResume;
    this.axeLabel = reason || 'Missing';
    this.stopAttack(true);
    this.setStatus('Waiting Axe');
    this.scheduleAxeRecoveryCheck();
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

  findUsableAxeItem() {
    if (!this.bot || !this.bot.inventory) return null;
    for (const item of this.bot.inventory.items()) {
      if (!this.matchesAxe(item)) continue;
      const timer = parseSelfDestructTimerFromItem(item);
      if (timer.expired) continue;
      return item;
    }
    return null;
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

    this.resumeFarmingAfterAxe = false;
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
    this.attackTargetCycleIndex = 0;
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

    const axeReady = await this.checkAxe();
    if (!axeReady || !this.attackLoopActive || !this.bot || this.disconnectHandled) return;

    const reach = Math.max(1, Number(this.settings.farm_reach_blocks) || 4.5);
    const target = this.selectAttackTarget(reach);
    if (!target) {
      this.logNoTargetDiagnostics(reach);
      return;
    }

    try {
      // Сбрасываем зависшее копание, если оно застряло с прошлого раза
      if (this.bot.targetDigging) {
        this.bot.stopDigging();
      }

      // Обязательно машем рукой для античита
      if (typeof this.bot.swingArm === 'function') this.bot.swingArm('right');

      this.recordFarmTarget(target);
      
      await Promise.race([
        this.bot.dig(target, true, 'raycast'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Digging timed out')), 800))
      ]);
      
      this.markFarmActivity();
      this.recordFarmTarget(target);
      this.logTargetBlock(target, target);

    } catch (err) {
      if (err.message === 'Digging aborted' || err.message === 'Digging timed out') {
        // Серверный плагин на автопродажу отменяет копание сундука, либо просто не отвечает
        this.markFarmActivity();
      } else if (err.message !== 'Block not in view') {
        this.logger.warn(`[Bot] Ошибка копания: ${err.message}`);
      }
    }
  }

  selectAttackTarget(reach) {
    const cursorTarget = this.bot ? this.bot.blockAtCursor(reach) : null;
    if (this.isAllowedAttackBlock(cursorTarget)) return cursorTarget;

    const targets = this.findAttackTargets(reach);
    if (!targets.length) return null;
    if (this.settings.target_cycle_enabled === false) {
      this.logThrottled('farm-scan-fallback-target', `Cursor target missing; using scan fallback ${this.describeBlock(targets[0])}`, 10000);
      return targets[0];
    }

    this.attackTargetCycleIndex %= targets.length;
    const target = targets[this.attackTargetCycleIndex];
    this.attackTargetCycleIndex = (this.attackTargetCycleIndex + 1) % targets.length;
    this.logThrottled('farm-scan-fallback-target', `Cursor target missing; using scan fallback ${this.describeBlock(target)}`, 10000);
    return target;
  }

  findAttackTargets(reach) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return [];
    const origin = this.bot.entity.position;
    const maxDistance = Math.max(1, Math.ceil(Number(reach) || 5));
    const targetsByInventory = new Map();
    const seen = new Set();

    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -maxDistance; dx <= maxDistance; dx += 1) {
        for (let dz = -maxDistance; dz <= maxDistance; dz += 1) {
          const pos = origin.floored().offset(dx, dy, dz);
          const key = this.blockPositionKey(pos);
          if (seen.has(key)) continue;
          seen.add(key);

          const block = this.bot.blockAt(pos);
          if (!this.isAllowedAttackBlock(block)) continue;

          const center = block.position.offset(0.5, 0.5, 0.5);
          const distance = origin.distanceTo(center);
          if (!Number.isFinite(distance) || distance > reach + 0.75) continue;
          const inventoryKey = this.attackTargetInventoryKey(block);
          const previous = targetsByInventory.get(inventoryKey);
          if (!previous || distance < previous.distance) {
            targetsByInventory.set(inventoryKey, { block, distance, key: inventoryKey });
          }
        }
      }
    }

    return [...targetsByInventory.values()]
      .sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key))
      .map((item) => item.block);
  }

  attackTargetInventoryKey(block) {
    if (!block || !block.position) return '';
    const name = String(block.name || '').toLowerCase();
    const baseKey = `${name}:${this.blockPositionKey(block.position)}`;
    if (!this.isDoubleChestBlockName(name) || !this.bot) return baseKey;

    const adjacentKeys = [this.blockPositionKey(block.position)];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbor = this.bot.blockAt(block.position.offset(dx, 0, dz));
      if (neighbor && String(neighbor.name || '').toLowerCase() === name) {
        adjacentKeys.push(this.blockPositionKey(neighbor.position));
      }
    }

    if (adjacentKeys.length <= 1) return baseKey;
    adjacentKeys.sort();
    return `${name}:${adjacentKeys.slice(0, 2).join('|')}`;
  }

  isDoubleChestBlockName(name) {
    const normalized = String(name || '').toLowerCase();
    return normalized === 'chest' || normalized === 'trapped_chest';
  }

  markFarmActivity(now = Date.now()) {
    this.lastFarmActivityAt = now;
    if (this.homeRecoveryState === HOME_RECOVERY.monitoring && this.bot && this.bot.entity && this.bot.entity.position) {
      this.markHomeRecoveryMovement(now);
    }
  }

  recordFarmTarget(block, now = Date.now()) {
    if (!block || !block.position) return;
    this.lastFarmTarget = {
      name: String(block.name || 'unknown'),
      position: vectorSnapshot(block.position),
      at: now
    };
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
    const block = { name: String(name || '').toLowerCase(), position: { x: 0, y: 0, z: 0 } };
    return this.isAllowedAttackBlock(block);
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

  homeRecoveryDiagnosticLine(now = Date.now()) {
    try {
      const entity = this.bot && this.bot.entity;
      const reach = Math.max(1, Number(this.settings.farm_reach_blocks) || 4.5);
      const targets = this.findAttackTargets(reach);
      const cursorBlock = this.bot ? this.bot.blockAtCursor(reach) : null;
      const held = this.bot && this.bot.heldItem;
      const pos = entity && entity.position
        ? `${entity.position.x.toFixed(2)},${entity.position.y.toFixed(2)},${entity.position.z.toFixed(2)}`
        : '-';
      const yaw = entity ? radiansToDegrees(entity.yaw).toFixed(1) : '-';
      const pitch = entity ? radiansToDegrees(entity.pitch).toFixed(1) : '-';
      const lastFarmAgo = this.lastFarmActivityAt ? formatDuration(now - this.lastFarmActivityAt) : 'never';
      const lastMoveAgo = this.homeRecoveryLastMovedAt ? formatDuration(now - this.homeRecoveryLastMovedAt) : 'never';
      const lastTarget = this.lastFarmTarget && this.lastFarmTarget.position
        ? `${this.lastFarmTarget.name}@${this.lastFarmTarget.position.x},${this.lastFarmTarget.position.y},${this.lastFarmTarget.position.z}${this.lastFarmTarget.at ? ` ${formatDuration(now - this.lastFarmTarget.at)} ago` : ''}`
        : 'none';
      const nearestTargets = targets
        .slice(0, 3)
        .map((block) => this.describeBlock(block))
        .join('|') || 'none';

      return discordInline([
        `status=${this.status}`,
        `attack=${this.attackLoopActive ? 'on' : 'off'}`,
        `digging=${this.isDigging() ? this.describeBlock(this.getDigTarget()) : 'no'}`,
        `axe=${this.axeLabel || '-'}`,
        `held=${this.describeItem(held)}`,
        `pos=${pos}`,
        `yaw=${yaw}`,
        `pitch=${pitch}`,
        `reach=${reach}`,
        `targets=${targets.length}`,
        `nearest=${nearestTargets}`,
        `cursor=${this.describeBlock(cursorBlock)}`,
        `lastFarm=${lastFarmAgo}`,
        `lastMove=${lastMoveAgo}`,
        `lastTarget=${lastTarget}`
      ].join(' | '), 900);
    } catch (error) {
      return `diagnostic failed: ${discordInline(error.message || error, 160)}`;
    }
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
    const text = normalizeMinecraftText(message);
    this.handleTpaProgressMessage(text);
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

  recordChatLine(direction, message, kind = '') {
    const text = normalizeMinecraftText(message).trim();
    if (!text) return;
    const directionKey = String(direction || 'IN').toUpperCase();
    const chatKind = normalizeChatKind(kind);
    if (directionKey === 'IN' && !shouldShowMinecraftChatLine({ text, kind: chatKind })) return;
    const dedupeKey = `${directionKey}:${chatKind}:${text}`;
    const now = Date.now();
    if (this.lastRecordedChatKey === dedupeKey && now - this.lastRecordedChatAt < 750) return;
    this.lastRecordedChatKey = dedupeKey;
    this.lastRecordedChatAt = now;
    const entry = {
      at: now,
      direction: directionKey,
      kind: chatKind,
      text: text.slice(0, 500)
    };
    this.chatLog.push(entry);
    if (this.chatLog.length > 120) this.chatLog.splice(0, this.chatLog.length - 120);
    appendMinecraftChatLog(this.botConfig.username, entry, this.logger);
  }

  getChatLog(limit = 30) {
    const count = Math.max(1, Math.min(80, Number(limit) || 30));
    const fileEntries = readMinecraftChatLog(this.botConfig.username, Math.max(count * 12, count), this.logger);
    if (fileEntries.length) return filterMinecraftChatEntries(fileEntries, count);
    return filterMinecraftChatEntries(this.chatLog, count);
  }

  sendConsoleChat(command) {
    this.sendChat(command);
  }

  async handleTpa(sender) {
    if (this.tpaInProgress || !this.bot || this.disconnectHandled) return;
    const tpaStartedAt = Date.now();
    this.tpaInProgress = true;
    this.pendingTpaSender = sender;
    this.tpaAcceptedNotified = false;
    this.tpaAttemptNotified = false;
    this.tpaFailureNotified = false;
    try {
      this.logger.info(`Starting TPA workflow for ${sender}`);
      this.stopAttack(true);
      this.closeCurrentWindow('before TPA');
      this.setStatus('TPA Trade');
      this.sendChat(this.settings.home_trade_command);
      await sleep(Number(this.settings.teleport_wait_ms) || 1000);
      this.closeCurrentWindow('before tpaccept');
      this.sendChat(`/tpaccept ${sender}`);
      await sleep(500);
      this.sendChat('/tpaccept');
      await sleep(1500);
      if (!this.tpaAcceptedNotified && !this.tpaFailureNotified) {
        this.notifyTpaAttempt(sender);
      }
      
      // Даем время на телепортацию
      this.setStatus('Waiting Return');
      await sleep(Number(this.settings.teleport_wait_ms) || 1000);

      await this.sendHomeCommandAndWait(
        this.settings.home_farm_command,
        Number(this.settings.teleport_wait_ms) || 1000,
        `TPA return from ${sender}`
      );
      if (!this.tpaAcceptedNotified && !this.tpaFailureNotified) {
        this.logger.warn(`TPA workflow for ${sender} had no server confirmation after return home; reconnect disabled`);
        this.notifyTpaNoConfirmation(sender, tpaStartedAt);
      }
    } finally {
      this.tpaInProgress = false;
      this.pendingTpaSender = '';
      if (this.status === 'TPA Trade' || this.status === 'Waiting Return') this.setStatus('Ready');
      this.startFarming();
    }
  }

  handleTpaProgressMessage(message) {
    if (!this.tpaInProgress || !this.pendingTpaSender) return;
    const text = normalizeMinecraftText(message).trim();
    if (!text) return;
    const lower = text.toLowerCase();
    if (isTpaFailureMessage(lower)) {
      this.notifyTpaFailure(this.pendingTpaSender, text);
      return;
    }
    if (isTpaAcceptedMessage(lower)) {
      this.notifyTpaAccepted(this.pendingTpaSender, text);
    }
  }

  notifyTpaAttempt(sender) {
    if (this.tpaAttemptNotified || this.tpaAcceptedNotified || this.tpaFailureNotified) return;
    this.tpaAttemptNotified = true;
    this.logger.info(`TPA accept commands sent for ${sender}; no confirmation seen yet`);
    this.manager.dashboard?.sendLog(`🤝 \`${this.displayName()}\` sent TPA accept for **${sender}**; waiting for server confirmation.`);
  }

  notifyTpaAccepted(sender, detail = '') {
    if (this.tpaAcceptedNotified) return;
    this.tpaAcceptedNotified = true;
    const suffix = detail ? ` (${String(detail).slice(0, 160)})` : '';
    this.logger.info(`TPA accepted for ${sender}${detail ? `: ${detail}` : ''}`);
    this.manager.dashboard?.sendLog(`🤝 \`${this.displayName()}\` accepted TPA request from **${sender}**${suffix}`);
  }

  notifyTpaFailure(sender, detail = '') {
    if (this.tpaFailureNotified || this.tpaAcceptedNotified) return;
    this.tpaFailureNotified = true;
    const reason = detail ? ` Reason: \`${String(detail).slice(0, 180)}\`` : '';
    this.logger.warn(`TPA accept may have failed for ${sender}${detail ? `: ${detail}` : ''}`);
    this.manager.dashboard?.sendLog(`⚠️ \`${this.displayName()}\` TPA accept may have failed for **${sender}**.${reason}`);
  }

  notifyTpaNoConfirmation(sender, startedAt = Date.now()) {
    if (this.tpaFailureNotified || this.tpaAcceptedNotified) return;
    this.tpaFailureNotified = true;
    const suffix = this.tpaDiagnosticSuffix(startedAt);
    const reason = suffix
      ? `Minecraft chat did not confirm TPA accept. ${suffix}`
      : 'Minecraft chat did not confirm TPA accept and no useful chat lines were captured.';
    this.logger.warn(`TPA accept not confirmed for ${sender}: ${reason}`);
    this.manager.dashboard?.sendLog(`⚠️ \`${this.displayName()}\` TPA accept may have failed for **${sender}**. Reason: \`${discordInline(reason, 700)}\``);
  }

  tpaDiagnosticSuffix(startedAt = Date.now()) {
    const lines = [];
    for (const entry of this.chatLog.slice(-30)) {
      if (!entry || !entry.text || entry.at < startedAt - 2000) continue;
      if (entry.direction !== 'IN') continue;
      if (!shouldShowMinecraftChatLine(entry)) continue;
      const text = normalizeMinecraftText(entry.text).trim();
      if (!text || lines.includes(text)) continue;
      lines.push(text);
    }
    const shown = lines.map((line) => discordInline(line, 160)).filter(Boolean).slice(-5);
    return shown.length ? `Chat: ${shown.map((line) => `\`${line}\``).join(' | ')}` : '';
  }

  findWhitelistedTpaSender(message) {
    if (!looksLikeTpaMessage(message)) return '';
    const text = normalizeMinecraftText(message).toLowerCase();
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
      this.recordChatLine('OUT', command);
      this.bot.chat(command);
    } catch (error) {
      this.logger.warn(`Failed to send chat command ${command}`, error.message || error);
    }
  }

  closeCurrentWindow(reason = 'cleanup') {
    const window = this.bot && this.bot.currentWindow;
    if (!window || typeof this.bot.closeWindow !== 'function') return false;
    try {
      this.bot.closeWindow(window);
      this.logger.info(`Closed current window (${reason}): ${describeWindow(window)}`);
      return true;
    } catch (error) {
      this.logger.warn(`Failed to close current window (${reason}): ${error.message || error}`);
      return false;
    }
  }

  async handleWindowOpen(window) {
    if (!this.bot || !window) return;

    // Авто-подтверждение TPA GUI (DonutSMP)
    if (this.tpaInProgress && window.slots) {
      const confirmSlot = window.slots.findIndex((item) => {
        const name = String(item && item.name || '');
        return name.includes('lime_stained_glass_pane') || name.includes('green_stained_glass_pane');
      });
      if (confirmSlot >= 0) {
        this.logger.info(`Found TPA confirm GUI, clicking green button (slot ${confirmSlot})`);
        try {
          await this.bot.clickWindow(confirmSlot, 0, 0);
          this.bot.closeWindow(window);
          if (this.pendingTpaSender) this.notifyTpaAccepted(this.pendingTpaSender, 'confirmed TPA GUI');
          return;
        } catch (err) {
          this.logger.warn(`Failed to click TPA confirm button: ${err.message}`);
        }
      }
    }

    if (!this.config.server.exploit_protection) return;
    const type = String(window.type || '').toLowerCase();
    const title = normalizeMinecraftText(window.title || window.name || '').trim().toLowerCase();
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

function vectorSnapshot(position) {
  if (!position) return null;
  const x = Number(position.x);
  const y = Number(position.y);
  const z = Number(position.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return {
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    z: Math.round(z * 100) / 100
  };
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

function rememberCashoutReply(payment, message) {
  if (!payment) return;
  const text = normalizeMinecraftText(message).trim();
  if (!text) return;
  if (!Array.isArray(payment.replies)) payment.replies = [];
  if (payment.replies[payment.replies.length - 1] !== text) payment.replies.push(text.slice(0, 500));
  if (payment.replies.length > 12) payment.replies.splice(0, payment.replies.length - 12);
}

function isTemporaryCashoutFailure(message) {
  const text = normalizeMinecraftText(message).toLowerCase();
  if (!text) return false;
  return (
    text.includes('cannot process') ||
    text.includes('can not process') ||
    text.includes('at the moment') ||
    text.includes('try again') ||
    text.includes('temporarily') ||
    text.includes('temporary') ||
    text.includes('currently unable')
  );
}

function resetCashoutPaymentForRetry(payment) {
  if (!payment) return;
  payment.success = false;
  payment.error = false;
  payment.message = '';
  payment.replies = [];
  payment.chat = [];
  payment.startedAt = Date.now();
}

function isHomeTeleportSuccessMessage(message) {
  const lower = normalizeMinecraftText(message).toLowerCase();
  return HOME_SUCCESS_MARKERS.some((marker) => lower.includes(marker));
}

function rememberHomeCommandChatLine(lines, message, kind = '') {
  if (!Array.isArray(lines)) return;
  const text = normalizeMinecraftText(message).trim();
  if (!text) return;
  const chatKind = normalizeChatKind(kind);
  if (!shouldShowMinecraftChatLine({ direction: 'IN', text, kind: chatKind })) return;
  if (lines[lines.length - 1] !== text) lines.push(text.slice(0, 500));
  if (lines.length > 12) lines.splice(0, lines.length - 12);
}

function homeCommandDiagnosticSuffix(lines) {
  const shown = (Array.isArray(lines) ? lines : [])
    .map((line) => discordInline(line, 160))
    .filter(Boolean)
    .slice(-5);
  return shown.length ? `Minecraft chat: ${shown.map((line) => `\`${line}\``).join(' | ')}` : '';
}

function rememberGameBalanceChatLine(lines, message, kind = '') {
  if (!Array.isArray(lines)) return;
  const text = normalizeMinecraftText(message).trim();
  if (!text) return;
  const chatKind = normalizeChatKind(kind);
  if (!shouldShowMinecraftChatLine({ direction: 'IN', text, kind: chatKind })) return;
  if (lines[lines.length - 1] !== text) lines.push(text.slice(0, 500));
  if (lines.length > 12) lines.splice(0, lines.length - 12);
}

function gameBalanceDiagnosticSuffix(result) {
  const chat = result && Array.isArray(result.chat) ? result.chat : [];
  const shown = chat.map((line) => discordInline(line, 160)).filter(Boolean).slice(-5);
  return shown.length ? ` chat=${shown.map((line) => `"${line}"`).join(' | ')}` : ' chat=none';
}

function gameBalanceDiscordDiagnostic(result) {
  const chat = result && Array.isArray(result.chat) ? result.chat : [];
  const shown = chat.map((line) => discordInline(line, 160)).filter(Boolean).slice(-5);
  return shown.length ? `Minecraft chat: ${shown.map((line) => `\`${line}\``).join(' | ')}` : 'Minecraft chat: no useful lines captured';
}

function rememberCashoutChat(payment, message, kind = '') {
  if (!payment) return;
  const text = normalizeMinecraftText(message).trim();
  if (!text) return;
  const chatKind = normalizeChatKind(kind);
  if (!shouldShowMinecraftChatLine({ direction: 'IN', text, kind: chatKind })) return;
  if (!Array.isArray(payment.chat)) payment.chat = [];
  const entry = text.slice(0, 500);
  if (payment.chat[payment.chat.length - 1] !== entry) payment.chat.push(entry);
  if (payment.chat.length > 12) payment.chat.splice(0, payment.chat.length - 12);
}

function latestCashoutChatReason(payment) {
  if (!payment) return '';
  const replies = Array.isArray(payment.replies) ? payment.replies : [];
  if (payment.message) return normalizeMinecraftText(payment.message).trim();
  if (replies.length) return normalizeMinecraftText(replies[replies.length - 1]).trim();

  const chat = Array.isArray(payment.chat) ? payment.chat : [];
  const target = String(payment.target || '').toLowerCase();
  const amount = Number(payment.amount);
  const amountText = Number.isFinite(amount) && amount > 0 ? String(Math.floor(amount)) : '';
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    const text = normalizeMinecraftText(chat[index]).trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    const compact = text.replace(/[,\s]/g, '');
    if (
      /pay|paid|payment|transfer|sent|balance|money|cash|\$|донат|перев|плат|баланс|денег|отправ|ошибка|error|failed|cannot|can't|limit|cooldown|usage|invalid|not found|нельзя|лимит|кулдаун|не найден/i.test(text) ||
      (target && lower.includes(target)) ||
      (amountText && compact.includes(amountText))
    ) {
      return text;
    }
  }

  return chat.length ? normalizeMinecraftText(chat[chat.length - 1]).trim() : '';
}

function discordInline(value, maxLength = 180) {
  const text = normalizeMinecraftText(value)
    .replace(/`/g, 'ʼ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeChatKind(kind) {
  const text = String(kind || '').toLowerCase();
  if (text === 'game_info' || text === 'actionbar' || text === 'action_bar') return 'game_info';
  if (text === 'chat' || text === 'system') return text;
  return text || 'unknown';
}

function normalizeMinecraftChatEntry(entry) {
  if (!entry || !entry.text) return null;
  const text = normalizeMinecraftText(entry.text).trim();
  if (!text) return null;
  return {
    ...entry,
    direction: String(entry.direction || 'IN').toUpperCase(),
    kind: normalizeChatKind(entry.kind || entry.position || entry.type || ''),
    text: text.slice(0, 500)
  };
}

function filterMinecraftChatEntries(entries, limit) {
  const count = Math.max(1, Math.min(80, Number(limit) || 30));
  const out = [];
  let lastKey = '';
  for (const entry of entries || []) {
    const normalized = normalizeMinecraftChatEntry(entry);
    if (!normalized || !shouldShowMinecraftChatLine(normalized)) continue;
    const key = `${normalized.direction}:${normalized.kind}:${normalized.text}`;
    if (key === lastKey) continue;
    lastKey = key;
    out.push(normalized);
  }
  return out.slice(-count);
}

function shouldShowMinecraftChatLine(entry) {
  if (!entry || !entry.text) return false;
  if (String(entry.direction || '').toUpperCase() === 'OUT') return true;
  const text = normalizeMinecraftText(entry.text).trim();
  if (!text) return false;
  const kind = normalizeChatKind(entry.kind || entry.position || entry.type || '');
  if (kind === 'game_info') return false;
  if (isMoneyOnlyChatLine(text)) return false;
  if (isExpandedMoneyActionbarLine(text)) return false;
  return true;
}

function isMoneyOnlyChatLine(text) {
  const value = normalizeMinecraftText(text).replace(/\s+/g, ' ').trim();
  if (!value) return false;
  const tokens = value.split(/\s+/).filter(Boolean);
  return tokens.length > 0 &&
    tokens.every((token) => token === '$' || /^\$?[\d,.]+(?:[kmbt])?$/i.test(token)) &&
    tokens.some((token) => /^[\d,.]+(?:[kmbt])?$/i.test(token.replace(/^\$/, '')));
}

function isExpandedMoneyActionbarLine(text) {
  const value = normalizeMinecraftText(text).replace(/\s+/g, ' ').trim();
  if (!value || !value.includes('$')) return false;
  if (!/(#[0-9a-f]{6}|\bwhite\b|\bgray\b|\bgreen\b|\byellow\b|\bgold\b)/i.test(value)) return false;

  const cleaned = value
    .replace(/#[0-9a-f]{6}/gi, ' ')
    .replace(/\b(?:black|dark_blue|dark_green|dark_aqua|dark_red|dark_purple|gold|gray|dark_gray|blue|green|aqua|red|light_purple|yellow|white|reset|bold|italic|underlined|strikethrough|obfuscated)\b/gi, ' ')
    .replace(/\b0\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return false;

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  return tokens.every((token) => token === '$' || /^[\d,.]+(?:[kmbt])?$/i.test(token));
}

function describeWindow(window) {
  if (!window) return 'unknown window';
  const title = normalizeMinecraftText([window.title, window.name], { maxDepth: 6, maxStrings: 40 }).trim();
  const type = String(window.type || '').trim();
  const slotCount = Array.isArray(window.slots) ? window.slots.length : 0;
  return [type || 'window', title ? `title=${title}` : '', `slots=${slotCount}`].filter(Boolean).join(' ');
}

function isMicrosoftDeviceCodeExpired(lowerReason) {
  const text = String(lowerReason || '').toLowerCase();
  return text.includes('expired_token') && (
    text.includes('device_code') ||
    text.includes('device code') ||
    text.includes('code has expired')
  );
}

function cleanProfileName(value) {
  const text = String(value || '').trim();
  if (!text || text.includes('@')) return '';
  return /^[A-Za-z0-9_]{1,16}$/.test(text) ? text : '';
}

function isServerSecurityKick(kind, lowerReason) {
  if (kind !== 'kicked') return false;
  const text = String(lowerReason || '').toLowerCase();
  return text.includes('possible unauthorized login') ||
    text.includes('confirm it via the button in your discord dms') ||
    (text.includes('for your own safety') && text.includes('blocked it'));
}

function isServerBanKick(kind, lowerReason) {
  if (kind !== 'kicked') return false;
  const text = String(lowerReason || '').toLowerCase();
  return (
    text.includes('temporarily banned') ||
    text.includes('permanently banned') ||
    text.includes('you are banned') ||
    (text.includes('ban id') && text.includes('appeal'))
  );
}

function parseServerBan(reasonText) {
  const text = normalizeMinecraftText(reasonText, { preserveNewlines: true });
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const joined = lines.join('\n');
  const first = lines[0] || '';
  const lowerFirst = first.toLowerCase();
  const type = lowerFirst.includes('permanently banned')
    ? 'permanent'
    : lowerFirst.includes('temporarily banned')
      ? 'temporary'
      : lowerFirst.includes('banned')
        ? 'ban'
        : '';
  const timeMatch = joined.match(/time\s+left\s*:\s*([^\n]+)/i);
  const idMatch = joined.match(/ban\s+id\s*:\s*(#[A-Za-z0-9_-]+)/i);
  return {
    type,
    timeLeft: timeMatch ? timeMatch[1].trim() : '',
    id: idMatch ? idMatch[1].trim() : ''
  };
}

function parseTpaSender(message) {
  const text = normalizeMinecraftText(message);
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
  const text = normalizeMinecraftText(message).toLowerCase();
  return (
    /\btpa\b|\/tpaccept|\btpaccept\b/.test(text) ||
    /\bteleport request\b|\brequested to teleport\b|\bwants to teleport\b|\bsent you a teleport request\b/.test(text) ||
    /\bteleport\b.{0,40}\baccepted\b|\baccepted\b.{0,40}\bteleport\b/.test(text) ||
    /(?:просит|хочет|запрос).{0,80}телепорт|телепорт.{0,80}(?:запрос|принят|принял)/.test(text)
  );
}

function isTpaAcceptedMessage(lowerMessage) {
  const text = String(lowerMessage || '').toLowerCase();
  if (!looksLikeTpaMessage(text)) return false;
  return (
    text.includes('teleport request accepted') ||
    text.includes('request accepted') ||
    text.includes('you accepted') ||
    text.includes('successfully accepted') ||
    text.includes('accepted the teleport') ||
    text.includes('accepted your teleport') ||
    text.includes('принял запрос') ||
    text.includes('запрос принят') ||
    text.includes('принята')
  );
}

function isTpaFailureMessage(lowerMessage) {
  const text = String(lowerMessage || '').toLowerCase();
  if (!looksLikeTpaMessage(text)) return false;
  return (
    text.includes('no pending') ||
    text.includes('no teleport request') ||
    text.includes('no tpa request') ||
    text.includes('request expired') ||
    text.includes('has expired') ||
    text.includes('not found') ||
    text.includes('not online') ||
    text.includes('cancelled') ||
    text.includes('canceled') ||
    text.includes('denied') ||
    text.includes('declined') ||
    text.includes('нет актив') ||
    text.includes('истек') ||
    text.includes('отклон')
  );
}

function classifyCashoutReply(message, targetNickname, amount = 0) {
  const text = normalizeMinecraftText(message).trim();
  if (!text || text.startsWith('<')) return null;
  const lower = text.toLowerCase();
  const target = String(targetNickname || '').trim().toLowerCase();
  const mentionsTarget = !target || lower.includes(target);
  const amountText = Number.isFinite(Number(amount)) && Number(amount) > 0 ? String(Math.floor(Number(amount))) : '';
  const mentionsAmount = amountText ? text.replace(/[,\s]/g, '').includes(amountText) : false;
  const looksPaymentRelated = /pay|paid|payment|transfer|sent|balance|money|cash|\$|донат|перев|плат|баланс|денег|отправ/i.test(text);
  const errorMarkers = [
    'cannot',
    'error',
    'must',
    'limit',
    'limited',
    'maximum',
    'max',
    'daily',
    'wait',
    'insufficient',
    'not enough',
    'too low',
    'minimum',
    'invalid',
    'unknown',
    'not found',
    'not online',
    'usage',
    'cooldown',
    'failed',
    'expired',
    'blocked',
    'disabled',
    'недостаточно',
    'ошибка',
    'нельзя',
    'лимит',
    'не найден',
    'не в сети',
    'миним',
    'подожд',
    'кулдаун',
    'истек',
    'истёк',
    'отключ'
  ];
  const hasErrorMarker = errorMarkers.some((marker) => lower.includes(marker));
  const looksGenericCashoutFailure = hasErrorMarker &&
    /\b(?:process|processed|transaction|moment|currently|temporary|temporarily|try again|unable)\b/i.test(text) &&
    /\b(?:sorry|cannot|can't|unable|failed|error|try again)\b/i.test(text);

  if (!looksPaymentRelated && !mentionsTarget && !mentionsAmount && !looksGenericCashoutFailure) return null;

  if (hasErrorMarker) {
    return { type: 'error', message: text };
  }

  const successMarkers = [
    'successfully paid',
    'successfully transferred',
    'payment sent',
    'you paid',
    'you have paid',
    'you sent',
    'transferred',
    'paid',
    'sent',
    'перевел',
    'перевёл',
    'отправил',
    'заплатил',
    'успеш'
  ];
  if (mentionsTarget && successMarkers.some((marker) => lower.includes(marker))) {
    return { type: 'success', message: text };
  }

  return null;
}

function isTransientBalanceApiError(result) {
  if (!result || result.ok) return false;
  const code = String(result.code || '');
  return code === 'API_ERROR' ||
    code === 'GAME_BALANCE_TIMEOUT' ||
    code === 'SUSPICIOUS_BALANCE_JUMP' ||
    code === 'SUSPICIOUS_BALANCE_DROP' ||
    /^HTTP_5\d\d$/.test(code);
}

function parseGameBalanceMessage(message, username = '') {
  const text = normalizeMinecraftText(message).replace(/\s+/g, ' ').trim();
  if (!text || text.startsWith('<')) return NaN;
  if (/^(?:in|out)\s+\$/i.test(text)) return NaN;
  if (/\b(?:earned|received|income)\b/i.test(text) && !/\bbalance\b/i.test(text)) return NaN;

  const target = String(username || '').trim();
  const amount = '\\$?\\s*([\\d,]+(?:\\.\\d+)?(?:[kmbt])?)\\.?';
  const patterns = [];
  if (target) {
    const escaped = escapeRegExp(target);
    patterns.push(
      new RegExp(`\\b${escaped}\\s+(?:has|have)\\s+${amount}`, 'i'),
      new RegExp(`\\b${escaped}(?:'s)?\\s+(?:balance|bal|money|cash)\\s*(?:is|:|>|»)?\\s*${amount}`, 'i'),
      new RegExp(`\\b(?:balance|bal|money|cash)\\s+(?:of|for)\\s+${escaped}\\s*(?:is|:|>|»)?\\s*${amount}`, 'i')
    );
  }
  patterns.push(
    new RegExp(`\\byou\\s+(?:have|own)\\s+${amount}`, 'i'),
    new RegExp(`\\byour\\s+(?:balance|bal|money|cash)\\s*(?:is|:|>|»)?\\s*${amount}`, 'i'),
    new RegExp(`\\b(?:balance|bal|money|cash)\\s*(?:is|:|>|»)?\\s*${amount}`, 'i'),
    new RegExp(`\\b(?:баланс|деньги)\\s*(?:is|:|>|»)?\\s*${amount}`, 'i')
  );
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = parseCompactBalanceNumber(match[1]);
    if (Number.isFinite(value)) return value;
  }
  return NaN;
}

function parseCompactBalanceNumber(value) {
  const text = String(value || '').trim().toLowerCase();
  const match = text.match(/^([\d,.]+)\s*([kmbt])?$/i);
  if (!match) return NaN;
  const number = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(number)) return NaN;
  const suffix = match[2] || '';
  const multiplier = suffix === 'k'
    ? 1_000
    : suffix === 'm'
      ? 1_000_000
      : suffix === 'b'
        ? 1_000_000_000
        : suffix === 't'
          ? 1_000_000_000_000
          : 1;
  return number * multiplier;
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
          const normalized = normalizeMinecraftChatEntry(entry);
          if (normalized) entries.push(normalized);
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
