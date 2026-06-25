'use strict';

const { BotController } = require('./botController');
const { Dashboard } = require('./dashboard');
const { DonutApi } = require('./donutApi');
const { getProxyLabel } = require('./proxy');
const { writeJsonFile } = require('./utils');

class Manager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.donutApi = new DonutApi(config, logger.child('donut-api'));
    this.dashboard = new Dashboard(config, this, logger.child('dashboard'));
    this.controllers = [];
    this.commandCooldown = new Map();
    this.started = false;
  }

  async start() {
    if (this.started) return;
    this.started = true;

    this.controllers = this.config.bots
      .filter((botConfig) => botConfig.enabled !== false)
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
    await Promise.allSettled(this.controllers.map((controller) => controller.shutdown()));
    await this.dashboard.shutdown();
  }

  getSnapshots() {
    return this.config.bots.map((botConfig) => {
      const controller = this.controllers.find((ctrl) => ctrl.botConfig.username === botConfig.username);
      if (controller) return controller.snapshot();
      return {
        name: botConfig.nickname || botConfig.username,
        status: botConfig.enabled === false ? 'Configured / OFF' : 'Offline',
        balance: '-',
        axe: '-',
        proxy: getProxyLabel(botConfig.effective_proxy || botConfig.proxy || null),
        income: '-',
        hunger: '-/20',
        nextReconnectAt: 0,
        online: false,
        paused: botConfig.enabled === false
      };
    });
  }

  getProfitReferencePerHour(sourceController = null) {
    const configured = Number(
      sourceController && sourceController.settings
        ? sourceController.settings.profit_reference_per_hour
        : this.config.bot_defaults.profit_reference_per_hour
    ) || 47500000;

    const rates = this.controllers
      .filter((controller) => controller !== sourceController)
      .filter((controller) => controller.profitReady && Number(controller.shortPerHour) > 0)
      .map((controller) => Number(controller.shortPerHour))
      .sort((a, b) => a - b);

    if (!rates.length) return configured;
    const mid = Math.floor(rates.length / 2);
    const median = rates.length % 2 === 1
      ? rates[mid]
      : (rates[mid - 1] + rates[mid]) / 2;
    return Math.max(configured, median);
  }

  async checkAllAxes() {
    await Promise.allSettled(this.controllers.map((controller) => controller.checkAxe()));
  }

  async refreshAllBalances() {
    await Promise.allSettled(this.controllers.map((controller) => controller.refreshBalance()));
  }

  async cashoutAll() {
    const results = await Promise.allSettled(this.controllers.map((controller) => controller.cashout()));
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
      if (index > -1) this.config.bots.splice(index, 1);
      writeJsonFile('config.json', this.config);
      if (existingCtrl) {
        await existingCtrl.shutdown();
        this.controllers.splice(ctrlIndex, 1);
      }
      return `Deleted bot ${username}`;
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
      botConfig.enabled = Boolean(data.enabled);
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
}

module.exports = {
  Manager
};
