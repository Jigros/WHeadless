'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BotController } = require('./botController');
const { Dashboard } = require('./dashboard');
const { DonutApi } = require('./donutApi');
const { getProxyLabel } = require('./proxy');
const { formatCompactMoney, formatDuration, writeJsonFile } = require('./utils');

class Manager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.donutApi = new DonutApi(config, logger.child('donut-api'), {
      onHealthEvent: (event) => this.handleDonutApiHealthEvent(event)
    });
    this.dashboard = new Dashboard(config, this, logger.child('dashboard'));
    this.controllers = [];
    this.commandCooldown = new Map();
    this.profitAlertQueue = [];
    this.profitAlertTimer = null;
    this.started = false;
  }

  async start() {
    if (this.started) return;
    this.started = true;

    this.controllers = this.config.bots
      .filter((botConfig) => botConfig.enabled !== false && botConfig.ban_locked !== true)
      .map((botConfig, index) => (
        new BotController({
          botConfig,
          config: this.config,
          donutApi: this.donutApi,
          logger: this.logger.child(`bot-${index + 1}`),
          manager: this
        })
      ));

    this.dashboard.start().catch((error) => {
      this.logger.error('Discord dashboard failed to start', error);
    });

    this.logger.info('Waiting 45 seconds for ghost sessions to clear before connecting bots...');
    let delayMs = 45000;
    
    for (const controller of this.controllers) {
      setTimeout(() => {
        if (this.started) {
          controller.start();
        }
      }, delayMs);
      delayMs += 10000;
    }
  }

  async shutdown() {
    this.logger.info('Shutting down manager');
    if (this.profitAlertTimer) clearTimeout(this.profitAlertTimer);
    this.profitAlertTimer = null;
    this.profitAlertQueue = [];
    await Promise.allSettled(this.controllers.map((controller) => controller.shutdown()));
    await this.dashboard.shutdown();
  }

  handleDonutApiHealthEvent(event) {
    const message = formatDonutApiHealthEvent(event);
    if (!message) return;

    if (event.type === 'recovered') {
      this.logger.info(`Donut API recovered after ${formatDuration(event.durationMs)} failures=${event.failureCount}`);
    } else {
      const failure = event.lastFailure || {};
      this.logger.warn(`Donut API ${event.type === 'still_down' ? 'still down' : 'down'} code=${failure.code || '-'} failures=${event.failureCount}`);
    }

    const sent = this.dashboard?.sendLog(message);
    if (sent && typeof sent.catch === 'function') {
      sent.catch((error) => this.logger.warn(`Failed to send Donut API health log: ${error.message || error}`));
    }
  }

  queueProfitAlert(controller, alert) {
    this.profitAlertQueue.push({
      name: controller.displayName(),
      shortPerHour: Number(alert.shortPerHour) || 0,
      reference: Number(alert.reference) || 0,
      percent: Number(alert.percent) || 0,
      windowMs: Number(alert.windowMs) || 0,
      earned: Number(alert.earned) || 0,
      samples: Number(alert.samples) || 0
    });

    if (this.profitAlertTimer) return;
    const batchMs = Math.max(
      1000,
      Number(controller.settings && controller.settings.profit_alert_batch_ms) ||
        Number(this.config.bot_defaults && this.config.bot_defaults.profit_alert_batch_ms) ||
        60000
    );
    this.profitAlertTimer = setTimeout(() => this.flushProfitAlerts(), batchMs);
  }

  flushProfitAlerts() {
    const alerts = this.profitAlertQueue.splice(0);
    this.profitAlertTimer = null;
    if (!alerts.length) return;

    if (alerts.length === 1) {
      const alert = alerts[0];
      this.dashboard?.sendLog([
        `📉 \`${alert.name}\` sales dropped.`,
        `Now: \`$${formatCompactMoney(alert.shortPerHour)}/h\``,
        `Reference: \`$${formatCompactMoney(alert.reference)}/h\``,
        alert.windowMs ? `Window: \`${Math.round(alert.windowMs / 60000)}m\`` : '',
        alert.samples ? `Samples: \`${alert.samples}\`` : '',
        `Drop: \`${Math.round(alert.percent)}%\``
      ].filter(Boolean).join(' '));
      return;
    }

    const lines = alerts.map((alert) => (
      `- \`${alert.name}\`: now \`$${formatCompactMoney(alert.shortPerHour)}/h\`, reference \`$${formatCompactMoney(alert.reference)}/h\`, window \`${Math.round(alert.windowMs / 60000) || '?'}m\`, samples \`${alert.samples || '?'}\`, drop \`${Math.round(alert.percent)}%\``
    ));
    this.dashboard?.sendLog(`📉 Sales dropped for ${alerts.length} bots:\n${lines.join('\n')}`);
  }

  getSnapshots() {
    return this.config.bots.map((botConfig) => {
      const controller = this.controllers.find((ctrl) => ctrl.botConfig.username === botConfig.username);
      if (controller) return controller.snapshot();
      return {
        name: botConfig.nickname || botConfig.username,
        status: botConfig.ban_locked ? 'Banned / OFF' : (botConfig.enabled === false ? 'Configured / OFF' : 'Offline'),
        balance: '-',
        axe: '-',
        proxy: getProxyLabel(botConfig.effective_proxy || botConfig.proxy || null),
        income: '-',
        farm: { bot: null, target: null },
        hunger: '-/20',
        nextReconnectAt: 0,
        online: false,
        paused: botConfig.enabled === false || botConfig.ban_locked === true
      };
    });
  }

  getProfitReferencePerHour(sourceController = null) {
    const settings = sourceController && sourceController.settings
      ? sourceController.settings
      : (this.config.bot_defaults || {});
    const configured = Number(settings.profit_reference_per_hour) || 47500000;
    const minPeerCount = Math.max(1, Number(settings.profit_reference_min_peer_count) || 2);
    const useConfiguredFloor = settings.profit_reference_use_configured_floor === true;

    const now = Date.now();
    const rates = this.controllers
      .filter((controller) => controller !== sourceController)
      .filter((controller) => controller.profitReady)
      .map((controller) => this.controllerProfitReferenceRate(controller, now))
      .filter((rate) => rate > 0)
      .sort((a, b) => a - b);

    if (rates.length < minPeerCount) return configured;
    const mid = Math.floor(rates.length / 2);
    const median = rates.length % 2 === 1
      ? rates[mid]
      : (rates[mid - 1] + rates[mid]) / 2;
    return useConfiguredFloor ? Math.max(configured, median) : median;
  }

  controllerProfitReferenceRate(controller, now = Date.now()) {
    if (!controller) return 0;
    try {
      if (typeof controller.calculateWindowStats === 'function' && typeof controller.getProfitAlertWindowMs === 'function') {
        const windowMs = controller.getProfitAlertWindowMs();
        const stats = controller.calculateWindowStats(now, windowMs);
        const minSamples = Math.max(2, Number(controller.settings && controller.settings.profit_alert_min_samples) || 4);
        const coverage = Math.max(10, Math.min(100, Number(controller.settings && controller.settings.profit_alert_min_coverage_percent) || 70));
        if (stats.samples >= minSamples && stats.spanMs >= windowMs * (coverage / 100) && stats.perHour > 0) {
          return Number(stats.perHour) || 0;
        }
      }
    } catch (error) {
      this.logger.debug(`Profit reference rate fallback for ${controller.displayName()}: ${error.message || error}`);
    }
    return Number(controller.shortPerHour) || 0;
  }

  async checkAllAxes() {
    await Promise.allSettled(this.controllers.map((controller) => controller.checkAxe()));
  }

  async refreshAllBalances() {
    await Promise.allSettled(this.controllers.map((controller) => controller.refreshBalance()));
  }

  async getGameBalanceForTarget(username) {
    const target = String(username || '').trim();
    if (!target) return null;
    const controller = this.controllers.find((item) => (
      item &&
      item.bot &&
      !item.disconnectHandled &&
      !item.userPaused &&
      !item.pausedAuto &&
      typeof item.getGameBalance === 'function'
    ));
    if (!controller) return null;
    return controller.getGameBalance(target, { source: 'cashout-target' });
  }

  async cashoutAll() {
    const tasks = this.controllers.map((controller) => controller.cashout());
    const results = await Promise.allSettled(tasks);
    return results.filter((result) => result.status === 'fulfilled' && result.value).length;
  }

  reconnectAll() {
    for (const controller of this.controllers) controller.reconnectNow();
  }

  pauseAll(reason) {
    for (const controller of this.controllers) controller.pause(reason);
  }

  resumeAll() {
    for (const controller of this.controllers) controller.resume();
  }

  offlineList() {
    const offline = this.getSnapshots()
      .filter((bot) => !bot.online)
      .map((bot) => `${bot.name}: ${bot.status}`);
    return offline.join('\n');
  }

  isWhitelisted(username) {
    const target = String(username || '').toLowerCase();
    const wl = this.config.whitelist || [];
    return wl.some((u) => String(u).toLowerCase() === target);
  }

  async handleMinecraftCommand(sourceController, username, message) {
    if (!this.isWhitelisted(username)) return;
    const command = String(message || '').trim().toLowerCase();
    if (!command.startsWith('!')) return;

    const key = `${username}:${command}`;
    const now = Date.now();
    if ((this.commandCooldown.get(key) || 0) + 3000 > now) return;
    this.commandCooldown.set(key, now);

    if (command === '!payall') {
      this.logger.info(`!payall requested by ${username} through ${sourceController.displayName()}`);
      await this.cashoutAll();
      return;
    }

    if (command === '!return') {
      this.logger.info(`!return requested by ${username}`);
      for (const controller of this.controllers) controller.signalReturn(username);
    }
  }

  alertCritical(controller, message) {
    const line = `[${controller.displayName()}] ${message}`;
    this.logger.error(line);
    this.dashboard.sendAlert(line).catch((error) => {
      this.logger.warn('Unable to send critical alert', error);
    });
  }

  async manageBot(username, data, actionText) {
    const index = this.config.bots.findIndex(b => b.username === username);
    const ctrlIndex = this.controllers.findIndex(c => c.botConfig.username === username);
    const existingCtrl = this.controllers[ctrlIndex];

    if (actionText === 'DELETE') {
      const botConfig = index > -1 ? this.config.bots[index] : { username };
      const cleanupNames = [
        username,
        botConfig.username,
        botConfig.nickname,
        botConfig.stats_username,
        existingCtrl && existingCtrl.realUsername
      ].filter(Boolean);
      if (existingCtrl) {
        await existingCtrl.shutdown();
        this.controllers.splice(ctrlIndex, 1);
      }
      const cleanup = this.deleteBotLocalData(cleanupNames);
      if (index > -1) this.config.bots.splice(index, 1);
      writeJsonFile('config.json', this.config);
      return `Deleted bot ${username}. Removed auth files: ${cleanup.auth}; chat logs: ${cleanup.chat}`;
    }

    if (actionText === 'OFF') {
      if (index > -1) {
        this.config.bots[index].enabled = false;
        writeJsonFile('config.json', this.config);
      }
      if (existingCtrl) {
        await existingCtrl.safeClose('Disabled from Dashboard', true);
        this.controllers.splice(ctrlIndex, 1);
        return `Turned OFF bot ${username}`;
      }
      return `Bot ${username} is already offline.`;
    }

    if (actionText === 'ON') {
      if (index > -1 && this.config.bots[index].ban_locked) {
        return `Bot ${username} is ban-locked and cannot be turned ON. Ban ID: ${this.config.bots[index].ban_id || 'unknown'}`;
      }
      if (index > -1) {
        this.config.bots[index].enabled = true;
        writeJsonFile('config.json', this.config);
      }
      if (existingCtrl) {
        existingCtrl.userPaused = false;
        existingCtrl.pausedAuto = false;
        existingCtrl.disconnectHandled = false;
        existingCtrl.manualClose = false;
        existingCtrl.announceNextLogin = Boolean(this.config.bots[index] && this.config.bots[index].announce_login_on_next_start);
        existingCtrl.connect();
        return `Turned ON bot ${username}`;
      }
      if (index > -1) {
        const botConfig = this.config.bots[index];
        const newCtrl = new BotController({
          botConfig,
          config: this.config,
          donutApi: this.donutApi,
          logger: this.logger.child(username),
          manager: this
        });
        this.controllers.push(newCtrl);
        if (this.started) newCtrl.start();
        return `Turned ON bot ${username}`;
      }
    }

    let botConfig;
    if (index > -1) {
      botConfig = this.config.bots[index];
    } else {
      botConfig = { username };
      this.config.bots.push(botConfig);
    }

    if (Object.prototype.hasOwnProperty.call(data, 'enabled')) {
      if (botConfig.ban_locked && Boolean(data.enabled)) {
        botConfig.enabled = false;
      } else {
        botConfig.enabled = Boolean(data.enabled);
      }
    }
    if (Object.prototype.hasOwnProperty.call(data, 'announce_login_on_next_start')) {
      botConfig.announce_login_on_next_start = Boolean(data.announce_login_on_next_start);
    }

    if (Object.prototype.hasOwnProperty.call(data, 'nickname')) {
      botConfig.nickname = data.nickname;
      botConfig.stats_username = data.nickname;
    }
    
    if (data.proxy_action === 'remove') {
      delete botConfig.proxy;
      delete botConfig.effective_proxy;
    } else if (data.proxy_host) {
      botConfig.proxy = botConfig.proxy || { type: 'socks5' };
      botConfig.proxy.type = data.proxy_type || botConfig.proxy.type || 'socks5';
      botConfig.proxy.host = data.proxy_host;
      botConfig.proxy.port = parseInt(data.proxy_port, 10);
      if (data.proxy_user) {
        botConfig.proxy.username = data.proxy_user;
        botConfig.proxy.password = data.proxy_pass;
      } else {
        delete botConfig.proxy.username;
        delete botConfig.proxy.password;
      }
      botConfig.effective_proxy = botConfig.proxy;
    }

    writeJsonFile('config.json', this.config);

    if (existingCtrl) {
      await existingCtrl.shutdown();
      this.controllers.splice(ctrlIndex, 1);
    }

    if (botConfig.enabled === false) {
      return `Saved bot ${username} (OFF)`;
    }

    const newCtrl = new BotController({
      botConfig,
      config: this.config,
      donutApi: this.donutApi,
      logger: this.logger.child(username),
      manager: this
    });

    this.controllers.push(newCtrl);
    if (this.started) {
      newCtrl.start();
    }
    return `Updated and restarted bot ${username}`;
  }

  deleteBotLocalData(names) {
    const uniqueNames = [...new Set((names || []).map((name) => String(name || '').trim()).filter(Boolean))];
    return {
      auth: this.deleteBotAuthCache(uniqueNames),
      chat: this.deleteBotChatLogs(uniqueNames)
    };
  }

  deleteBotAuthCache(names) {
    const dir = this.config.auth && this.config.auth.profiles_folder;
    if (!dir || !fs.existsSync(dir)) return 0;

    const prefixes = new Set(names.map((name) => this.prismarineAuthHash(name)));
    let removed = 0;
    for (const fileName of fs.readdirSync(dir)) {
      if (!fileName.endsWith('-cache.json')) continue;
      const prefix = fileName.split('_')[0];
      if (!prefixes.has(prefix)) continue;

      const filePath = path.join(dir, fileName);
      try {
        fs.rmSync(filePath, { force: true });
        removed += 1;
        this.logger.info(`Deleted auth cache ${filePath}`);
      } catch (error) {
        this.logger.warn(`Failed to delete auth cache ${filePath}: ${error.message || error}`);
      }
    }
    return removed;
  }

  deleteBotChatLogs(names) {
    const dir = path.join(process.cwd(), 'logs', 'minecraft-chat');
    if (!fs.existsSync(dir)) return 0;

    const prefixes = new Set(names.map((name) => `${safeLogName(name)}-`));
    let removed = 0;
    for (const fileName of fs.readdirSync(dir)) {
      if (!fileName.endsWith('.jsonl')) continue;
      if (![...prefixes].some((prefix) => fileName.startsWith(prefix))) continue;

      const filePath = path.join(dir, fileName);
      try {
        fs.rmSync(filePath, { force: true });
        removed += 1;
        this.logger.info(`Deleted chat log ${filePath}`);
      } catch (error) {
        this.logger.warn(`Failed to delete chat log ${filePath}: ${error.message || error}`);
      }
    }
    return removed;
  }

  prismarineAuthHash(username) {
    return crypto.createHash('sha1')
      .update(username ?? '', 'binary')
      .digest('hex')
      .slice(0, 6);
  }
}

function safeLogName(value) {
  return String(value || 'unknown').replace(/[^a-z0-9_.@-]+/gi, '_').slice(0, 80) || 'unknown';
}

function formatDonutApiHealthEvent(event) {
  if (!event || !event.type) return '';
  const failure = event.lastFailure || event.firstFailure || {};
  const lines = [];

  if (event.type === 'recovered') {
    lines.push('Donut API RECOVERED: balance checks are working again.');
  } else if (event.type === 'still_down') {
    lines.push('Donut API STILL DOWN: balance checks are still failing.');
  } else {
    lines.push('Donut API DOWN: balance checks started failing.');
  }

  if (event.downAt) {
    lines.push(`Started: ${discordTimestamp(event.downAt)} (${discordRelativeTimestamp(event.downAt)})`);
  }
  if (event.type === 'recovered' && event.at) {
    lines.push(`Recovered: ${discordTimestamp(event.at)} (${discordRelativeTimestamp(event.at)})`);
  }
  if (Number.isFinite(Number(event.durationMs)) && Number(event.durationMs) > 0) {
    lines.push(`Duration: ${formatDuration(event.durationMs)}`);
  }
  if (event.lastOkAt) {
    lines.push(`Previous OK: ${discordTimestamp(event.lastOkAt)} (${discordRelativeTimestamp(event.lastOkAt)})`);
  } else if (event.type !== 'recovered') {
    lines.push('Previous OK: none since this process started.');
  }

  lines.push(`Failures: ${Math.max(0, Number(event.failureCount) || 0)}`);
  if (event.firstFailure && event.firstFailure !== failure) {
    lines.push(`First failure: ${formatDonutApiFailure(event.firstFailure)}`);
  }
  lines.push(`Last failure: ${formatDonutApiFailure(failure)}`);

  if (event.recovery) {
    lines.push(`Recovery check: ${formatDonutApiRequest(event.recovery)}`);
  }

  if (event.type !== 'recovered') {
    lines.push('Effect: dashboard keeps cached balances when possible; cashout can use a fresh cached balance.');
  }

  return lines.join('\n').slice(0, 1900);
}

function formatDonutApiFailure(failure) {
  if (!failure) return '`unknown`';
  const parts = [
    `code=${failure.code || '-'}`,
    failure.status ? `http=${failure.status}${failure.statusText ? ` ${failure.statusText}` : ''}` : '',
    `target=${formatDonutApiTarget(failure)}`,
    failure.url ? `url=${failure.url}` : '',
    failure.message ? `detail=${failure.message}` : ''
  ].filter(Boolean);
  return discordCode(parts.join(' | '), 500);
}

function formatDonutApiRequest(request) {
  const parts = [
    `code=${request.code || 'OK'}`,
    request.status ? `http=${request.status}` : '',
    `target=${formatDonutApiTarget(request)}`,
    request.url ? `url=${request.url}` : ''
  ].filter(Boolean);
  return discordCode(parts.join(' | '), 500);
}

function formatDonutApiTarget(value) {
  const displayName = String(value && value.displayName || '').trim();
  const username = String(value && value.username || '').trim();
  if (displayName && username && displayName !== username) return `${displayName} (${username})`;
  return displayName || username || 'unknown';
}

function discordTimestamp(ms) {
  return `<t:${Math.floor(Number(ms) / 1000)}:F>`;
}

function discordRelativeTimestamp(ms) {
  return `<t:${Math.floor(Number(ms) / 1000)}:R>`;
}

function discordCode(value, maxLength = 240) {
  return `\`${discordInline(value, maxLength)}\``;
}

function discordInline(value, maxLength = 240) {
  const text = String(value || '')
    .replace(/`/g, 'ʼ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

module.exports = {
  Manager
};
