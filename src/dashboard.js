'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} = require('discord.js');
const { formatCompactMoney, normalizeMinecraftText, readJsonFile, writeJsonFile } = require('./utils');

const BUTTONS = {
  refresh: 'dashboard:refresh',
  checkAll: 'dashboard:check-all',
  cashoutAll: 'dashboard:cashout-all',
  reconnectAll: 'dashboard:reconnect-all',
  offlineList: 'dashboard:offline-list',
  farmCoords: 'dashboard:farm-coords',
  pause: 'dashboard:pause',
  resume: 'dashboard:resume'
};

class Dashboard {
  constructor(config, manager, logger) {
    this.config = config;
    this.manager = manager;
    this.logger = logger;
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });
    this.message = null;
    this.refreshTimer = null;
    this.refreshing = false;
    this.ready = false;
    this.targetBalanceLabel = '-';
    this.targetBalanceAt = 0;
  }

  async start() {
    this.client.once('clientReady', async () => {
      this.ready = true;
      this.logger.info(`Discord connected as ${this.client.user.tag}`);
      try {
        await this.ensureDashboardMessage();
        await this.registerCommands().catch((error) => {
          this.logger.warn('Slash command registration failed', error);
        });
        await this.refresh();
      } catch (error) {
        this.logger.error('Dashboard setup failed', error);
      }
      this.refreshTimer = setInterval(() => {
        this.refresh().catch((error) => this.logger.warn('Dashboard refresh failed', error));
      }, 30000);
    });

    this.client.on('interactionCreate', (interaction) => {
      if (interaction.isAutocomplete() && interaction.commandName === 'bot') {
        this.handleBotAutocomplete(interaction).catch((err) => this.logger.warn('Bot autocomplete err', err));
        return;
      }
      if (interaction.isChatInputCommand() && interaction.commandName === 'bot') {
        this.handleBotCommand(interaction).catch((err) => this.logger.warn('Bot command err', err));
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith('whitelist_modal_')) {
        this.handleWhitelistModal(interaction).catch((err) => this.logger.warn('Modal err', err));
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith('manage_bot_modal_')) {
        this.handleManageBotModal(interaction).catch((err) => this.logger.warn('Manage bot err', err));
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId === 'bot_create_modal') {
        this.handleBotCreateModal(interaction).catch((err) => this.logger.warn('Bot create modal err', err));
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith('bot_field_modal:')) {
        this.handleBotFieldModal(interaction).catch((err) => this.logger.warn('Bot field modal err', err));
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith('bot_chat_modal:')) {
        this.handleBotChatModal(interaction).catch((err) => this.logger.warn('Bot chat modal err', err));
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId === 'cashout_modal') {
        const nick = interaction.fields.getTextInputValue('nickname').trim();
        this.config.cashout_nickname = nick;
        writeJsonFile('config.json', this.config);
        interaction.reply({ content: `✅ Cashout nickname updated to **${nick}** for all bots.`, flags: 64 }).catch(console.error);
        return;
      }
      this.handleInteraction(interaction).catch((error) => {
        if (error.code === 10062) return; // Unknown interaction (harmless timeout)
        this.logger.warn('Interaction handling failed', error);
      });
    });

    this.client.on('error', (error) => this.logger.warn('Discord client error', error));
    await this.client.login(this.config.discord.token);
  }

  async sendLog(message) {
    if (!this.config.discord.log_channel_id) return;
    try {
      const channel = await this.client.channels.fetch(this.config.discord.log_channel_id);
      if (channel && channel.isTextBased()) {
        await channel.send(message);
      }
    } catch (e) {
      if (e.code === 'UND_ERR_CONNECT_TIMEOUT' || e.message?.includes('Timeout') || e.code === 'ECONNRESET') return;
      this.logger.warn('Failed to send discord log', e);
    }
  }

  async shutdown() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.client) this.client.destroy();
  }

  userAllowed(userId) {
    const allowed = this.config.discord.allowed_user_ids;
    return !Array.isArray(allowed) || allowed.length === 0 || allowed.includes(String(userId));
  }

  discordChoiceText(value, maxLength = 100) {
    const text = String(value || '');
    if (text.length <= maxLength) return text;
    if (maxLength <= 3) return text.slice(0, maxLength);
    return `${text.slice(0, maxLength - 3)}...`;
  }

  buildBotCommand() {
    const addEditableOptions = (subcommand) => subcommand
      .addStringOption((option) => option
        .setName('username')
        .setDescription('Microsoft email or exact Minecraft username')
        .setRequired(true)
        .setAutocomplete(true))
      .addStringOption((option) => option
        .setName('nickname')
        .setDescription('Optional in-game nickname for dashboard/stats')
        .setRequired(false))
      .addStringOption((option) => option
        .setName('proxy')
        .setDescription('host:port, full proxy shop block, or none')
        .setRequired(false))
      .addStringOption((option) => option
        .setName('proxy_auth')
        .setDescription('user:pass if proxy only contains host:port')
        .setRequired(false));

    const addUsernameOption = (subcommand) => subcommand
      .addStringOption((option) => option
        .setName('username')
        .setDescription('Bot username/email')
        .setRequired(true)
        .setAutocomplete(true));

    return new SlashCommandBuilder()
      .setName('bot')
      .setDescription('Manage WHeadless bots without opening Discord modals')
      .addSubcommand((subcommand) => addEditableOptions(
        subcommand
          .setName('add')
          .setDescription('Add a bot and start it')
      ))
      .addSubcommand((subcommand) => addEditableOptions(
        subcommand
          .setName('edit')
          .setDescription('Edit an existing bot and restart it')
      ))
      .addSubcommand((subcommand) => addUsernameOption(
        subcommand
          .setName('delete')
          .setDescription('Delete a bot')
      ))
      .addSubcommand((subcommand) => addUsernameOption(
        subcommand
          .setName('off')
          .setDescription('Turn a bot off')
      ))
      .addSubcommand((subcommand) => addUsernameOption(
        subcommand
          .setName('on')
          .setDescription('Turn a bot on')
      ));
  }

  async registerCommands() {
    const channel = await this.fetchDashboardChannel();
    const guild = channel.guild;
    if (!guild) {
      this.logger.warn('Dashboard channel has no guild; slash commands were not registered');
      return;
    }

    const payload = this.buildBotCommand().toJSON();
    const commands = await guild.commands.fetch();
    const existing = commands.find((command) => command.name === payload.name);
    if (existing) {
      await existing.edit(payload);
    } else {
      await guild.commands.create(payload);
    }
    this.logger.info('Registered /bot Discord command');
  }

  botOptionLabel(bot) {
    return this.discordChoiceText(bot.nickname || bot.username || 'Unnamed bot', 100);
  }

  getBotIndexFromCustomId(customId, position = 2) {
    const parts = String(customId || '').split(':');
    const index = Number(parts[position]);
    return Number.isInteger(index) && index >= 0 ? index : -1;
  }

  getBotByIndex(index) {
    const bots = this.config.bots || [];
    return bots[index] || null;
  }

  buildManageBotSelect(selectedIndex = -1) {
    const bots = this.config.bots || [];
    const options = [
      new StringSelectMenuOptionBuilder()
        .setLabel('Create New Bot')
        .setDescription('Add a new account first, then edit fields by buttons')
        .setValue('NEW_BOT')
    ];

    for (let i = 0; i < Math.min(bots.length, 24); i++) {
      const bot = bots[i];
      const username = String(bot.username || `bot-${i + 1}`);
      const option = new StringSelectMenuOptionBuilder()
        .setLabel(this.botOptionLabel(bot))
        .setDescription(this.discordChoiceText(username, 100))
        .setValue(`idx:${i}`);
      if (i === selectedIndex) option.setDefault(true);
      options.push(option);
    }

    return new StringSelectMenuBuilder()
      .setCustomId('select_bot_to_manage')
      .setPlaceholder('Select bot...')
      .addOptions(options);
  }

  buildManageHomePayload() {
    return {
      content: [
        '**Manage Bots**',
        'Select a bot, then edit one field at a time with buttons.',
        'For a new bot, create the username first; proxy and nickname can be added after that.'
      ].join('\n'),
      components: [new ActionRowBuilder().addComponents(this.buildManageBotSelect())]
    };
  }

  proxySummary(bot) {
    const proxy = bot && bot.proxy;
    if (!proxy || !proxy.host) return 'Local / none';
    const auth = proxy.username ? ` auth:${proxy.username}` : ' no-auth';
    const bad = bot.proxy_bad ? ' BAD' : '';
    return `${proxy.type || 'socks5'}://${proxy.host}:${proxy.port || 1080}${auth}${bad}`;
  }

  botPanelText(index, bot, notice = '') {
    const controller = this.manager.controllers.find((ctrl) => ctrl.botConfig.username === bot.username);
    const status = controller ? controller.status : (bot.ban_locked ? 'Banned / OFF' : (bot.enabled === false ? 'Configured / OFF' : 'No controller'));
    const nextReconnectAt = controller && controller.nextScheduledReconnectAt
      ? `<t:${Math.floor(controller.nextScheduledReconnectAt / 1000)}:R>`
      : '-';
    const lines = [
      `**Manage Bot: ${bot.nickname || bot.username}**`,
      `Username: \`${bot.username || '-'}\``,
      `Nickname: \`${bot.nickname || '-'}\``,
      `Stats: \`${bot.stats_username || bot.nickname || '-'}\``,
      `Proxy: \`${this.proxySummary(bot)}\``,
      `Status: \`${status}\``,
      `Next Reconnect: ${nextReconnectAt}`
    ];
    if (notice) lines.unshift(notice, '');
    if (index < 0) lines.push('', 'This bot no longer exists in config.');
    return lines.join('\n');
  }

  buildBotPanelPayload(index, notice = '') {
    const bot = this.getBotByIndex(index);
    if (!bot) return this.buildManageHomePayload();

    const select = this.buildManageBotSelect(index);
    const fieldRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bot:field:${index}:nickname`).setLabel('Nickname').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`bot:field:${index}:proxy`).setLabel('Proxy').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`bot:field:${index}:auth`).setLabel('Proxy Auth').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`bot:action:${index}:remove_proxy`).setLabel('Remove Proxy').setStyle(ButtonStyle.Danger)
    );
    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bot:action:${index}:on`).setLabel('ON').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`bot:action:${index}:off`).setLabel('OFF').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`bot:action:${index}:refresh`).setLabel('Refresh Panel').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`bot:action:${index}:delete`).setLabel('Delete').setStyle(ButtonStyle.Danger)
    );
    const toolsRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bot:tool:${index}:chat`).setLabel('Chat').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`bot:tool:${index}:send`).setLabel('Send Message').setStyle(ButtonStyle.Primary)
    );

    return {
      content: this.botPanelText(index, bot, notice),
      components: [
        new ActionRowBuilder().addComponents(select),
        fieldRow,
        actionRow,
        toolsRow
      ]
    };
  }

  buildBotFieldModal(index, field) {
    const bot = this.getBotByIndex(index);
    if (!bot) return null;

    const titleByField = {
      nickname: 'Set Bot Nickname',
      proxy: 'Set Bot Proxy',
      auth: 'Set Proxy Auth'
    };
    const modal = new ModalBuilder()
      .setCustomId(`bot_field_modal:${index}:${field}`)
      .setTitle(titleByField[field] || 'Edit Bot Field');

    if (field === 'nickname') {
      const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel('Nickname / stats username')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(String(bot.nickname || ''));
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return modal;
    }

    if (field === 'proxy') {
      const proxy = bot.proxy && bot.proxy.host ? `${bot.proxy.host}:${bot.proxy.port || 1080}` : '';
      const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel('Proxy block / host:port / none')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setPlaceholder('socks5 83031\nЛогин: user\nПароль: pass\nВаши IPs:\n1.2.3.4')
        .setValue(proxy);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return modal;
    }

    if (field === 'auth') {
      const auth = bot.proxy && bot.proxy.username ? `${bot.proxy.username}:${bot.proxy.password || ''}` : '';
      const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel('Proxy auth user:pass / empty clear')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(auth);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return modal;
    }

    return null;
  }

  buildCreateBotModal() {
    const modal = new ModalBuilder()
      .setCustomId('bot_create_modal')
      .setTitle('Create New Bot');
    const input = new TextInputBuilder()
      .setCustomId('username')
      .setLabel('Microsoft email / exact username')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return modal;
  }

  chatLineText(line) {
    const ts = line && line.at ? `<t:${Math.floor(line.at / 1000)}:T>` : '`--:--`';
    const direction = line && line.direction === 'OUT' ? 'OUT' : 'IN';
    const text = normalizeMinecraftText((line && line.text) || '').replace(/`/g, 'ʼ');
    return `${ts} \`${direction}\` ${this.discordChoiceText(text, 260)}`;
  }

  buildBotChatPayload(index, notice = '') {
    const bot = this.getBotByIndex(index);

    if (!bot) {
      return this.buildManageHomePayload();
    }

    const controller = this.manager.controllers.find((ctrl) => ctrl.botConfig.username === bot.username);
    const status = controller ? controller.status : (bot.ban_locked ? 'Banned / OFF' : (bot.enabled === false ? 'Configured / OFF' : 'No controller'));
    const chatEntries = controller ? controller.getChatLog(25) : this.readMinecraftChatLog(bot.username, 25);
    const lines = chatEntries.map((line) => this.chatLineText(line));
    const body = lines.length ? lines.join('\n') : '_No chat captured yet._';

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bot:tool:${index}:refresh_chat`).setLabel('Refresh Chat').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`bot:tool:${index}:send`).setLabel('Send Message').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`bot:action:${index}:refresh`).setLabel('Back').setStyle(ButtonStyle.Secondary)
    );

    return {
      content: [
        notice,
        `**Bot Chat: ${bot.nickname || bot.username}**`,
        `Status: \`${status}\``,
        '',
        body
      ].filter((line) => line !== '').join('\n').slice(0, 1900),
      components: [row]
    };
  }

  buildBotChatModal(index) {
    const bot = this.getBotByIndex(index);
    if (!bot) return null;
    const modal = new ModalBuilder()
      .setCustomId(`bot_chat_modal:${index}`)
      .setTitle('Send Bot Message');
    const input = new TextInputBuilder()
      .setCustomId('message')
      .setLabel(`Send as ${this.discordChoiceText(bot.nickname || bot.username, 35)}`)
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(256);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return modal;
  }

  buildScriptLogsHomePayload(notice = '') {
    const files = this.listScriptLogFiles();
    const components = [];
    if (files.length) {
      const select = new StringSelectMenuBuilder()
        .setCustomId('select_script_log')
        .setPlaceholder('Select script log file...')
        .addOptions(files.slice(0, 25).map((file) => (
          new StringSelectMenuOptionBuilder()
            .setLabel(this.discordChoiceText(file.label, 100))
            .setDescription(this.discordChoiceText(`${file.sizeLabel} ${file.name}`, 100))
            .setValue(file.name)
        )));
      components.push(new ActionRowBuilder().addComponents(select));
    }
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dashboard:script_logs').setLabel('Refresh Files').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('scriptlog:download_recent').setLabel('Download Recent Logs').setStyle(ButtonStyle.Primary)
    ));
    return {
      content: [
        notice,
        '**Script Logs**',
        files.length
          ? 'Select a log file by start/rotation time.'
          : 'No script log files yet. Restart the script once after this update.'
      ].filter(Boolean).join('\n'),
      components
    };
  }

  buildScriptLogFilePayload(fileName, notice = '') {
    const file = this.listScriptLogFiles().find((item) => item.name === fileName);
    if (!file) return this.buildScriptLogsHomePayload('Log file was not found.');
    const lines = this.readTailLines(file.path, 120, 512 * 1024);
    const previewLines = this.fitDiscordLogPreview(lines, 1250);
    const omitted = Math.max(0, lines.length - previewLines.length);
    const body = previewLines.length
      ? [
          omitted ? `_Preview shows the newest lines; ${omitted} older preview line(s) omitted._` : '',
          ...previewLines.map((line) => `\`${this.discordChoiceText(line, 220).replace(/`/g, 'ʼ')}\``)
        ].filter(Boolean).join('\n')
      : '_Log file is empty._';
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`scriptlog:refresh:${file.name}`).setLabel('Refresh Log').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`scriptlog:download:${file.name}`).setLabel('Download Full').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('dashboard:script_logs').setLabel('Back').setStyle(ButtonStyle.Secondary)
    );
    return {
      content: [
        notice,
        `**Script Log: ${file.label}**`,
        `File: \`${file.name}\``,
        `Size: \`${file.sizeLabel}\``,
        'Discord message preview is limited; use **Download Full** for the complete file.',
        '',
        body
      ].filter((line) => line !== '').join('\n').slice(0, 1900),
      components: [row]
    };
  }

  listScriptLogFiles() {
    const dir = this.scriptLogsDir();
    try {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter((name) => /^script-.+\.log$/i.test(name))
        .map((name) => {
          const filePath = path.join(dir, name);
          const stat = fs.statSync(filePath);
          return {
            name,
            path: filePath,
            mtimeMs: stat.mtimeMs,
            sizeLabel: this.formatBytes(stat.size),
            label: this.scriptLogLabel(name, stat.mtimeMs)
          };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch (error) {
      this.logger.warn(`Failed to list script logs: ${error.message || error}`);
      return [];
    }
  }

  scriptLogsDir() {
    return path.join(process.cwd(), 'logs', 'script');
  }

  scriptLogLabel(fileName, fallbackTimeMs) {
    const match = String(fileName || '').match(/^script-(.+)\.log$/i);
    if (!match) return new Date(fallbackTimeMs).toLocaleString('ru-RU');
    const iso = match[1].replace(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
      '$1-$2-$3T$4:$5:$6.$7Z'
    );
    const date = new Date(iso);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU') : fileName;
  }

  formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} B`;
  }

  readMinecraftChatLog(username, limit = 25) {
    const dir = path.join(process.cwd(), 'logs', 'minecraft-chat');
    try {
      if (!fs.existsSync(dir)) return [];
      const prefix = `${this.safeLogName(username)}-`;
      const files = fs.readdirSync(dir)
        .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl'))
        .sort()
        .slice(-4);
      const entries = [];
      for (const file of files) {
        const text = this.readTailLines(path.join(dir, file), Math.max(300, limit * 12), 128 * 1024).join('\n');
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          try {
            const entry = JSON.parse(line);
            const normalized = this.normalizeMinecraftChatEntry(entry);
            if (normalized) entries.push(normalized);
          } catch (error) {}
        }
      }
      return this.filterMinecraftChatEntries(entries, limit);
    } catch (error) {
      this.logger.warn(`Failed to read Minecraft chat logs: ${error.message || error}`);
      return [];
    }
  }

  filterMinecraftChatEntries(entries, limit = 25) {
    const count = Math.max(1, Math.min(80, Number(limit) || 25));
    const out = [];
    let lastKey = '';
    for (const entry of entries || []) {
      const normalized = this.normalizeMinecraftChatEntry(entry);
      if (!normalized || !this.shouldShowMinecraftChatLine(normalized)) continue;
      const key = `${normalized.direction}:${normalized.kind}:${normalized.text}`;
      if (key === lastKey) continue;
      lastKey = key;
      out.push(normalized);
    }
    return out.slice(-count);
  }

  normalizeMinecraftChatEntry(entry) {
    if (!entry || !entry.text) return null;
    const text = normalizeMinecraftText(entry.text).trim();
    if (!text) return null;
    return {
      ...entry,
      direction: String(entry.direction || 'IN').toUpperCase(),
      kind: this.normalizeMinecraftChatKind(entry.kind || entry.position || entry.type || ''),
      text: text.slice(0, 500)
    };
  }

  normalizeMinecraftChatKind(kind) {
    const text = String(kind || '').toLowerCase();
    if (text === 'game_info' || text === 'actionbar' || text === 'action_bar') return 'game_info';
    if (text === 'chat' || text === 'system') return text;
    return text || 'unknown';
  }

  shouldShowMinecraftChatLine(entry) {
    if (!entry || !entry.text) return false;
    if (String(entry.direction || '').toUpperCase() === 'OUT') return true;
    const text = normalizeMinecraftText(entry.text).trim();
    if (!text) return false;
    const kind = this.normalizeMinecraftChatKind(entry.kind || entry.position || entry.type || '');
    if (kind === 'game_info') return false;
    return !this.isMoneyNoiseChatLine(text);
  }

  isMoneyNoiseChatLine(text) {
    const value = normalizeMinecraftText(text).replace(/\s+/g, ' ').trim();
    const tokens = value.split(/\s+/).filter(Boolean);
    if (tokens.length > 0 &&
      tokens.every((token) => token === '$' || /^\$?[\d,.]+(?:[kmbt])?$/i.test(token)) &&
      tokens.some((token) => /^[\d,.]+(?:[kmbt])?$/i.test(token.replace(/^\$/, '')))) {
      return true;
    }
    if (!value.includes('$')) return false;
    if (!/(#[0-9a-f]{6}|\bwhite\b|\bgray\b|\bgreen\b|\byellow\b|\bgold\b)/i.test(value)) return false;

    const cleaned = value
      .replace(/#[0-9a-f]{6}/gi, ' ')
      .replace(/\b(?:black|dark_blue|dark_green|dark_aqua|dark_red|dark_purple|gold|gray|dark_gray|blue|green|aqua|red|light_purple|yellow|white|reset|bold|italic|underlined|strikethrough|obfuscated)\b/gi, ' ')
      .replace(/\b0\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return false;

    const cleanedTokens = cleaned.split(/\s+/).filter(Boolean);
    return cleanedTokens.length > 0 && cleanedTokens.every((token) => token === '$' || /^[\d,.]+(?:[kmbt])?$/i.test(token));
  }

  safeLogName(value) {
    return String(value || 'unknown').replace(/[^a-z0-9_.@-]+/gi, '_').slice(0, 80) || 'unknown';
  }

  readTailLines(filePath, maxLines, maxBytes) {
    try {
      if (!fs.existsSync(filePath)) return [];
      const stat = fs.statSync(filePath);
      const bytes = Math.min(stat.size, maxBytes);
      const fd = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.alloc(bytes);
        fs.readSync(fd, buffer, 0, bytes, stat.size - bytes);
        return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-maxLines);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      this.logger.warn(`Failed to read script log file ${filePath}: ${error.message || error}`);
      return [];
    }
  }

  fitDiscordLogPreview(lines, maxChars) {
    const out = [];
    let used = 0;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = this.discordChoiceText(lines[index], 220).replace(/`/g, 'ʼ');
      const cost = line.length + 4;
      if (out.length && used + cost > maxChars) break;
      out.unshift(lines[index]);
      used += cost;
    }
    return out;
  }

  scriptLogFileByName(fileName) {
    return this.listScriptLogFiles().find((item) => item.name === fileName) || null;
  }

  async sendScriptLogAttachment(interaction, fileName) {
    const file = this.scriptLogFileByName(fileName);
    if (!file || !fs.existsSync(file.path)) {
      await interaction.reply({ content: 'Log file was not found.', flags: 64 });
      return;
    }

    const maxUploadBytes = 24 * 1024 * 1024;
    const stat = fs.statSync(file.path);
    if (stat.size > maxUploadBytes) {
      await interaction.reply({
        content: `Log file is too large for Discord upload (${this.formatBytes(stat.size)}). Path: \`${file.path}\``,
        flags: 64
      });
      return;
    }

    const attachment = new AttachmentBuilder(file.path, { name: file.name });
    await interaction.reply({
      content: `Full script log: \`${file.name}\` (${file.sizeLabel})`,
      files: [attachment],
      flags: 64
    });
  }

  async sendRecentScriptLogsAttachment(interaction) {
    const files = this.listScriptLogFiles().slice(0, 25);
    if (!files.length) {
      await interaction.reply({ content: 'No script log files found.', flags: 64 });
      return;
    }

    const maxUploadBytes = 24 * 1024 * 1024;
    let totalBytes = 0;
    const chunks = [];
    let included = 0;
    let truncated = false;

    for (const file of files) {
      const header = `\n\n===== ${file.name} (${file.sizeLabel}) =====\n`;
      const body = fs.readFileSync(file.path, 'utf8');
      const nextBytes = Buffer.byteLength(header) + Buffer.byteLength(body);
      if (totalBytes + nextBytes > maxUploadBytes) {
        if (included === 0) {
          await interaction.reply({
            content: `Newest log file is too large for Discord upload (${file.sizeLabel}). Use the server file directly: \`${file.path}\``,
            flags: 64
          });
          return;
        }
        truncated = true;
        break;
      }
      chunks.unshift(header, body);
      totalBytes += nextBytes;
      included += 1;
    }

    const note = truncated
      ? `Included newest ${included} file(s); older files skipped because of Discord upload limit.`
      : `Included ${included} recent file(s).`;
    const content = `${note}\n${chunks.join('')}`;
    const attachment = new AttachmentBuilder(Buffer.from(content, 'utf8'), {
      name: `script-logs-recent-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    });
    await interaction.reply({
      content: `${note} Size: \`${this.formatBytes(Buffer.byteLength(content))}\``,
      files: [attachment],
      flags: 64
    });
  }

  async handleInteraction(interaction) {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
    
    if (interaction.customId === 'dashboard:manage_bot') {
      if (!this.userAllowed(interaction.user.id)) return interaction.reply({ content: 'Not allowed.', flags: 64 });
      await interaction.reply({ ...this.buildManageHomePayload(), flags: 64 });
      return;
    }

    if (interaction.customId === 'dashboard:script_logs') {
      if (!this.userAllowed(interaction.user.id)) return interaction.reply({ content: 'Not allowed.', flags: 64 });
      const payload = this.buildScriptLogsHomePayload();
      if (interaction.isButton() && this.message && interaction.message && interaction.message.id !== this.message.id) {
        await interaction.update(payload);
      } else {
        await interaction.reply({ ...payload, flags: 64 });
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select_script_log') {
      if (!this.userAllowed(interaction.user.id)) return interaction.reply({ content: 'Not allowed.', flags: 64 });
      await interaction.update(this.buildScriptLogFilePayload(interaction.values[0]));
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('scriptlog:refresh:')) {
      if (!this.userAllowed(interaction.user.id)) return interaction.reply({ content: 'Not allowed.', flags: 64 });
      const fileName = interaction.customId.slice('scriptlog:refresh:'.length);
      await interaction.update(this.buildScriptLogFilePayload(fileName, 'Refreshed.'));
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('scriptlog:download:')) {
      if (!this.userAllowed(interaction.user.id)) return interaction.reply({ content: 'Not allowed.', flags: 64 });
      const fileName = interaction.customId.slice('scriptlog:download:'.length);
      await this.sendScriptLogAttachment(interaction, fileName);
      return;
    }

    if (interaction.isButton() && interaction.customId === 'scriptlog:download_recent') {
      if (!this.userAllowed(interaction.user.id)) return interaction.reply({ content: 'Not allowed.', flags: 64 });
      await this.sendRecentScriptLogsAttachment(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select_bot_to_manage') {
      const selected = interaction.values[0];
      if (selected === 'NEW_BOT') {
        await interaction.showModal(this.buildCreateBotModal());
        return;
      }

      const match = selected.match(/^idx:(\d+)$/);
      const index = match ? Number(match[1]) : -1;
      await interaction.update(this.buildBotPanelPayload(index));
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('bot:tool:')) {
      await this.handleBotToolAction(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('bot:field:')) {
      if (!this.userAllowed(interaction.user.id)) return interaction.reply({ content: 'Not allowed.', flags: 64 });
      const parts = interaction.customId.split(':');
      const index = this.getBotIndexFromCustomId(interaction.customId);
      const field = parts[3];
      const modal = this.buildBotFieldModal(index, field);
      if (!modal) {
        await interaction.reply({ content: 'Bot or field was not found.', flags: 64 });
        return;
      }
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('bot:action:')) {
      await this.handleBotPanelAction(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('bot:confirm_delete:')) {
      await this.handleBotDeleteConfirm(interaction);
      return;
    }

    if (interaction.customId === 'dashboard:whitelist') {
      if (!this.userAllowed(interaction.user.id)) return interaction.reply({ content: 'Not allowed.', flags: 64 });
      
      const wl = this.config.whitelist || [];
      const text = wl.length ? wl.join('\n') : 'Empty';
      
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('wl:add').setLabel('Add Nick').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('wl:remove').setLabel('Remove Nick').setStyle(ButtonStyle.Danger)
      );
      
      await interaction.reply({
        content: `**Current Whitelist:**\n\`\`\`\n${text}\n\`\`\``,
        components: [row],
        flags: 64
      });
      return;
    }

    if (interaction.customId === 'wl:add' || interaction.customId === 'wl:remove') {
      const action = interaction.customId === 'wl:add' ? 'add' : 'remove';
      const modal = new ModalBuilder()
        .setCustomId(`whitelist_modal_${action}`)
        .setTitle(`${action === 'add' ? 'Add to' : 'Remove from'} Whitelist`);

      const usernameInput = new TextInputBuilder()
        .setCustomId('username')
        .setLabel('Minecraft Username')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(usernameInput));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId === 'dashboard:set_cashout') {
      if (!this.userAllowed(interaction.user.id)) return interaction.reply({ content: 'Not allowed.', flags: 64 });
      const modal = new ModalBuilder()
        .setCustomId('cashout_modal')
        .setTitle('Set Cashout Target');
      const input = new TextInputBuilder()
        .setCustomId('nickname')
        .setLabel('New Nickname (e.g. chandw)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    if (!Object.values(BUTTONS).includes(interaction.customId)) return;

    if (!this.userAllowed(interaction.user.id)) {
      await interaction.reply({ content: 'You are not allowed to control this dashboard.', flags: 64 });
      return;
    }

    await interaction.deferReply({ flags: 64 });
    let reply = 'Done.';

    if (interaction.customId === BUTTONS.refresh) {
      await this.refresh();
      reply = 'Dashboard refreshed.';
    } else if (interaction.customId === BUTTONS.farmCoords) {
      reply = this.buildFarmCoordsText();
    } else if (interaction.customId === BUTTONS.checkAll) {
      await this.manager.checkAllAxes();
      await this.refresh();
      reply = 'Axe checks queued.';
    } else if (interaction.customId === BUTTONS.cashoutAll) {
      const count = await this.manager.cashoutAll();
      await this.refresh();
      reply = `Cashout attempted for ${count} bot(s).`;
    } else if (interaction.customId === BUTTONS.reconnectAll) {
      this.manager.reconnectAll();
      await this.refresh();
      reply = 'Reconnect requested for all bots.';
    } else if (interaction.customId === BUTTONS.offlineList) {
      reply = this.manager.offlineList() || 'No offline bots.';
    } else if (interaction.customId === BUTTONS.pause) {
      this.manager.pauseAll('Paused from Discord');
      await this.refresh();
      reply = 'All bots paused.';
    } else if (interaction.customId === BUTTONS.resume) {
      this.manager.resumeAll();
      await this.refresh();
      reply = 'All bots resumed.';
    }

    await interaction.editReply({ content: reply });
  }

  async handleWhitelistModal(interaction) {
    if (!this.userAllowed(interaction.user.id)) return interaction.reply({ content: 'Not allowed.', flags: 64 });
    
    const action = interaction.customId.replace('whitelist_modal_', '');
    const username = interaction.fields.getTextInputValue('username').trim();
    
    let wl = this.config.whitelist || [];
    if (action === 'add') {
      if (!wl.includes(username)) wl.push(username);
    } else if (action === 'remove') {
      wl = wl.filter(u => u.toLowerCase() !== username.toLowerCase());
    } else {
      return interaction.reply({ content: "Unknown action.", flags: 64 });
    }
    
    this.config.whitelist = wl;
    writeJsonFile('config.json', this.config);
    await interaction.reply({ content: `✅ Successfully ${action}ed **${username}** to whitelist.`, flags: 64 });
  }

  async handleManageBotModal(interaction) {
    if (!this.userAllowed(interaction.user.id)) return interaction.reply({ content: 'Not allowed.', flags: 64 });
    
    await interaction.deferReply({ flags: 64 });
    const username = interaction.fields.getTextInputValue('username').trim();
    if (!username) return interaction.editReply({ content: 'Username/Email is required.' });

    const data = {};
    const proxyHost = interaction.fields.getTextInputValue('proxy_host').trim();
    const proxyAuth = interaction.fields.getTextInputValue('proxy_auth').trim();
    this.applyProxyInput(data, proxyHost, proxyAuth);

    const action = interaction.fields.getTextInputValue('action').trim().toUpperCase();

    try {
      const resultMsg = await this.manager.manageBot(username, data, action);
      await this.refresh();
      await interaction.editReply({ content: `✅ ${resultMsg}` });
    } catch (e) {
      this.logger.error('manageBot error', e);
      await interaction.editReply({ content: `❌ Error: ${e.message}` });
    }
  }

  async handleBotPanelAction(interaction) {
    if (!this.userAllowed(interaction.user.id)) {
      await interaction.reply({ content: 'Not allowed.', flags: 64 });
      return;
    }

    const parts = interaction.customId.split(':');
    const index = this.getBotIndexFromCustomId(interaction.customId);
    const action = parts[3];
    const bot = this.getBotByIndex(index);
    if (!bot) {
      await interaction.update(this.buildManageHomePayload());
      return;
    }

    if (action === 'refresh') {
      await interaction.update(this.buildBotPanelPayload(index, 'Refreshed.'));
      return;
    }

    if (action === 'delete') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bot:confirm_delete:${index}`).setLabel('Confirm Delete').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`bot:action:${index}:refresh`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      );
      await interaction.update({
        content: [
          `**Delete ${bot.nickname || bot.username}?**`,
          `Username: \`${bot.username}\``,
          '',
          'This removes it from config and shuts down its controller.'
        ].join('\n'),
        components: [row]
      });
      return;
    }

    const actionText = {
      on: 'ON',
      off: 'OFF'
    }[action];

    try {
      let resultMsg = '';
      if (action === 'remove_proxy') {
        resultMsg = await this.manager.manageBot(bot.username, { proxy_action: 'remove' }, '');
      } else if (actionText) {
        resultMsg = await this.manager.manageBot(bot.username, {}, actionText);
      } else {
        await interaction.reply({ content: 'Unknown bot action.', flags: 64 });
        return;
      }

      await this.refresh();
      const nextIndex = this.config.bots.findIndex((item) => item.username === bot.username);
      await interaction.update(this.buildBotPanelPayload(nextIndex, `✅ ${resultMsg}`));
    } catch (e) {
      this.logger.error('bot panel action error', e);
      await interaction.reply({ content: `❌ Error: ${e.message}`, flags: 64 });
    }
  }

  async handleBotDeleteConfirm(interaction) {
    if (!this.userAllowed(interaction.user.id)) {
      await interaction.reply({ content: 'Not allowed.', flags: 64 });
      return;
    }

    const index = this.getBotIndexFromCustomId(interaction.customId, 2);
    const bot = this.getBotByIndex(index);
    if (!bot) {
      await interaction.update(this.buildManageHomePayload());
      return;
    }

    try {
      const resultMsg = await this.manager.manageBot(bot.username, {}, 'DELETE');
      await this.refresh();
      const payload = this.buildManageHomePayload();
      payload.content = `✅ ${resultMsg}\n\n${payload.content}`;
      await interaction.update(payload);
    } catch (e) {
      this.logger.error('bot delete error', e);
      await interaction.reply({ content: `❌ Error: ${e.message}`, flags: 64 });
    }
  }

  async handleBotCreateModal(interaction) {
    if (!this.userAllowed(interaction.user.id)) return interaction.reply({ content: 'Not allowed.', flags: 64 });

    await interaction.deferReply({ flags: 64 });
    const username = interaction.fields.getTextInputValue('username').trim();
    if (!username) {
      await interaction.editReply({ content: 'Username/Email is required.' });
      return;
    }

    const existingIndex = this.config.bots.findIndex((bot) => bot.username === username);
    if (existingIndex >= 0) {
      await interaction.editReply(this.buildBotPanelPayload(existingIndex, 'This bot already exists.'));
      return;
    }

    try {
      const resultMsg = await this.manager.manageBot(username, {
        enabled: false,
        announce_login_on_next_start: true
      }, '');
      await this.refresh();
      const index = this.config.bots.findIndex((bot) => bot.username === username);
      await interaction.editReply(this.buildBotPanelPayload(index, `✅ ${resultMsg}`));
    } catch (e) {
      this.logger.error('bot create modal error', e);
      await interaction.editReply({ content: `❌ Error: ${e.message}` });
    }
  }

  async handleBotFieldModal(interaction) {
    if (!this.userAllowed(interaction.user.id)) return interaction.reply({ content: 'Not allowed.', flags: 64 });

    await interaction.deferReply({ flags: 64 });
    const parts = interaction.customId.split(':');
    const index = this.getBotIndexFromCustomId(interaction.customId, 1);
    const field = parts[2];
    const bot = this.getBotByIndex(index);
    if (!bot) {
      await interaction.editReply(this.buildManageHomePayload());
      return;
    }

    const value = interaction.fields.getTextInputValue('value').trim();
    const data = {};

    try {
      if (field === 'nickname') {
        data.nickname = value;
      } else if (field === 'proxy') {
        this.applyProxyInput(data, value, '');
        if (value && value.toLowerCase() !== 'none' && bot.proxy && bot.proxy.username && !data.proxy_user) {
          data.proxy_user = bot.proxy.username;
          data.proxy_pass = bot.proxy.password || '';
        }
      } else if (field === 'auth') {
        if (!bot.proxy || !bot.proxy.host) {
          throw new Error('Set proxy host first, then proxy auth.');
        }
        data.proxy_host = bot.proxy.host;
        data.proxy_port = String(bot.proxy.port || 1080);
        if (value) {
          this.applyProxyInput(data, '', value);
        }
      } else {
        throw new Error('Unknown field.');
      }

      const resultMsg = await this.manager.manageBot(bot.username, data, '');
      await this.refresh();
      const nextIndex = this.config.bots.findIndex((item) => item.username === bot.username);
      await interaction.editReply(this.buildBotPanelPayload(nextIndex, `✅ ${resultMsg}`));
    } catch (e) {
      this.logger.error('bot field modal error', e);
      await interaction.editReply({ content: `❌ Error: ${e.message}` });
    }
  }

  async handleBotToolAction(interaction) {
    if (!this.userAllowed(interaction.user.id)) {
      await interaction.reply({ content: 'Not allowed.', flags: 64 });
      return;
    }

    const parts = interaction.customId.split(':');
    const index = Number(parts[2]);
    const action = parts[3];
    const bot = this.getBotByIndex(index);
    if (!bot) {
      await interaction.update(this.buildManageHomePayload());
      return;
    }

    if (action === 'chat' || action === 'refresh_chat') {
      await interaction.update(this.buildBotChatPayload(index, action === 'refresh_chat' ? 'Refreshed.' : ''));
      return;
    }

    if (action === 'send') {
      const modal = this.buildBotChatModal(index);
      if (!modal) {
        await interaction.reply({ content: 'Bot was not found.', flags: 64 });
        return;
      }
      await interaction.showModal(modal);
      return;
    }

    await interaction.reply({ content: 'Unknown bot tool.', flags: 64 });
  }

  async handleBotChatModal(interaction) {
    if (!this.userAllowed(interaction.user.id)) return interaction.reply({ content: 'Not allowed.', flags: 64 });

    await interaction.deferReply({ flags: 64 });
    const index = this.getBotIndexFromCustomId(interaction.customId, 1);
    const bot = this.getBotByIndex(index);
    if (!bot) {
      await interaction.editReply(this.buildBotChatPayload());
      return;
    }

    const controller = this.manager.controllers.find((ctrl) => ctrl.botConfig.username === bot.username);
    if (!controller || !controller.bot || controller.disconnectHandled) {
      await interaction.editReply(this.buildBotChatPayload(index, `❌ ${bot.nickname || bot.username} is offline.`));
      return;
    }

    const message = interaction.fields.getTextInputValue('message').trim();
    if (!message) {
      await interaction.editReply(this.buildBotChatPayload(index, 'Message is empty.'));
      return;
    }

    controller.sendConsoleChat(message);
    await interaction.editReply(this.buildBotChatPayload(index, `✅ Sent: \`${this.discordChoiceText(message.replace(/`/g, 'ʼ'), 120)}\``));
  }

  async handleBotAutocomplete(interaction) {
    if (!this.userAllowed(interaction.user.id)) {
      await interaction.respond([]);
      return;
    }

    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'username') {
      await interaction.respond([]);
      return;
    }

    const needle = String(focused.value || '').toLowerCase();
    const options = (this.config.bots || [])
      .filter((bot) => {
        const username = String(bot.username || '').toLowerCase();
        const nickname = String(bot.nickname || '').toLowerCase();
        return !needle || username.includes(needle) || nickname.includes(needle);
      })
      .slice(0, 25)
      .map((bot) => {
        const username = String(bot.username || '');
        const nickname = String(bot.nickname || '').trim();
        const label = nickname && nickname !== username
          ? `${nickname} (${username})`
          : username;
        return {
          name: this.discordChoiceText(label),
          value: this.discordChoiceText(username)
        };
      });

    await interaction.respond(options);
  }

  async handleBotCommand(interaction) {
    if (!this.userAllowed(interaction.user.id)) {
      await interaction.reply({ content: 'Not allowed.', flags: 64 });
      return;
    }

    await interaction.deferReply({ flags: 64 });

    const subcommand = interaction.options.getSubcommand();
    const username = String(interaction.options.getString('username', true) || '').trim();
    if (!username) {
      await interaction.editReply({ content: 'Username/Email is required.' });
      return;
    }

    const existing = (this.config.bots || []).find((bot) => bot.username === username);
    if (['edit', 'delete', 'off', 'on'].includes(subcommand) && !existing) {
      await interaction.editReply({ content: `❌ Bot \`${username}\` was not found. Use \`/bot add\` to create it.` });
      return;
    }

    const actionBySubcommand = {
      delete: 'DELETE',
      off: 'OFF',
      on: 'ON'
    };

    try {
      const data = {};
      const action = actionBySubcommand[subcommand] || '';

      if (subcommand === 'add' || subcommand === 'edit') {
        const nickname = String(interaction.options.getString('nickname') || '').trim();
        if (nickname) data.nickname = nickname;

        const proxy = String(interaction.options.getString('proxy') || '').trim();
        const proxyAuth = String(interaction.options.getString('proxy_auth') || '').trim();
        this.applyProxyInput(data, proxy, proxyAuth);
      }

      const resultMsg = await this.manager.manageBot(username, data, action);
      await this.refresh();
      await interaction.editReply({ content: `✅ ${resultMsg}` });
    } catch (e) {
      this.logger.error('bot slash command error', e);
      await interaction.editReply({ content: `❌ Error: ${e.message}` });
    }
  }

  applyProxyInput(data, proxyInput, proxyAuthInput) {
    const proxy = String(proxyInput || '').trim();
    const proxyAuth = String(proxyAuthInput || '').trim();

    if (proxy) {
      if (proxy.toLowerCase() === 'none') {
        data.proxy_action = 'remove';
        return;
      }

      const parsed = this.parseProxyInput(proxy);
      data.proxy_type = parsed.type;
      data.proxy_host = parsed.host;
      data.proxy_port = String(parsed.port);
      if (parsed.username) data.proxy_user = parsed.username;
      if (parsed.password) data.proxy_pass = parsed.password;
    }

    if (proxyAuth && proxyAuth.toLowerCase() !== 'none') {
      const authParts = proxyAuth.split(':');
      if (authParts.length < 2) {
        throw new Error('Proxy auth must be `user:pass`.');
      }
      data.proxy_user = authParts.shift();
      data.proxy_pass = authParts.join(':');
    }
  }

  parseProxyInput(proxyInput) {
    const text = String(proxyInput || '').trim();
    const block = this.parseProxyShopBlock(text);
    if (block) return block;

    const url = this.parseProxyUrl(text);
    if (url) return url;

    const inline = this.parseInlineProxy(text);
    if (inline) return inline;

    throw new Error('Proxy must be `host:port`, `host:port:user:pass`, full shop block, or `none`.');
  }

  parseProxyShopBlock(text) {
    const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) return null;

    let type = '';
    let port = 0;
    for (const line of lines) {
      const match = line.match(/\b(socks5|socks4|https?|http)\b\D{0,12}(\d{2,5})\b/i);
      if (!match) continue;
      type = this.normalizeProxyType(match[1]);
      port = Number(match[2]);
      break;
    }

    if (type && !this.validProxyPort(port)) {
      throw new Error(`Proxy port ${port} is invalid. TCP port must be 1-65535.`);
    }
    if (!type) return null;

    const username = this.extractLabeledProxyValue(text, ['логин', 'login', 'username', 'user']);
    const password = this.extractLabeledProxyValue(text, ['пароль', 'password', 'pass']);
    const host = this.extractProxyHostFromBlock(text);
    if (!host) return null;

    return { type, host, port, username, password };
  }

  parseProxyUrl(text) {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
    try {
      const url = new URL(text);
      const type = this.normalizeProxyType(url.protocol.replace(':', ''));
      const host = url.hostname;
      const port = Number(url.port);
      if (!this.validProxyType(type) || !host) return null;
      if (!this.validProxyPort(port)) {
        throw new Error(`Proxy port ${url.port || '?'} is invalid. TCP port must be 1-65535.`);
      }
      return {
        type,
        host,
        port,
        username: decodeURIComponent(url.username || ''),
        password: decodeURIComponent(url.password || '')
      };
    } catch (error) {
      if (error && String(error.message || '').includes('TCP port')) throw error;
      return null;
    }
  }

  parseInlineProxy(text) {
    const normalized = String(text || '').trim();
    const prefixed = normalized.match(/^(socks5|socks4|https?|http)\s+(.+)$/i);
    const type = this.normalizeProxyType(prefixed ? prefixed[1] : 'socks5');
    const body = prefixed ? prefixed[2].trim() : normalized.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const parts = body.split(':');
    if (parts.length < 2) return null;

    const host = parts.shift().trim();
    const port = Number(parts.shift());
    if (!host) return null;
    if (!this.validProxyPort(port)) {
      throw new Error(`Proxy port ${Number.isFinite(port) ? port : '?'} is invalid. TCP port must be 1-65535.`);
    }

    const parsed = { type, host, port, username: '', password: '' };
    if (parts.length) {
      parsed.username = parts.shift();
      parsed.password = parts.join(':');
    }
    return parsed;
  }

  extractLabeledProxyValue(text, labels) {
    const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const pattern = new RegExp(`(?:^|\\n)\\s*(?:${escaped})\\s*[:=\\-]\\s*(.+)`, 'i');
    const match = String(text || '').match(pattern);
    return match ? match[1].trim().split(/\s+/)[0] : '';
  }

  extractProxyHostFromBlock(text) {
    const afterIpLabel = String(text || '').match(/(?:ваши\s+ips?|ips?|ip|host|сервер)\s*:?\s*([\s\S]+)/i);
    const haystack = afterIpLabel ? afterIpLabel[1] : String(text || '');
    const ipv4 = haystack.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    if (ipv4 && this.validIPv4(ipv4[0])) return ipv4[0];

    const labeled = String(text || '').match(/(?:host|server|сервер)\s*[:=\-]\s*([a-z0-9.-]+\.[a-z0-9.-]+)/i);
    return labeled ? labeled[1].trim() : '';
  }

  normalizeProxyType(type) {
    return String(type || 'socks5').toLowerCase().replace(/:$/, '');
  }

  validProxyType(type) {
    return ['socks5', 'socks4', 'http', 'https'].includes(this.normalizeProxyType(type));
  }

  validProxyPort(port) {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
  }

  validIPv4(value) {
    const parts = String(value || '').split('.').map((part) => Number(part));
    return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  }

  async fetchDashboardChannel() {
    const channel = await this.client.channels.fetch(this.config.discord.dashboard_channel_id);
    if (!channel || !channel.isTextBased()) {
      throw new Error('discord.dashboard_channel_id does not point to a text channel');
    }
    return channel;
  }

  dashboardMessageId() {
    if (this.config.discord.dashboard_message_id) return this.config.discord.dashboard_message_id;
    const saved = readJsonFile(this.config.paths.dashboard_message, {});
    return saved && saved.message_id ? saved.message_id : '';
  }

  async ensureDashboardMessage() {
    const channel = await this.fetchDashboardChannel();
    const existingId = this.dashboardMessageId();
    if (existingId) {
      try {
        this.message = await channel.messages.fetch(existingId);
        return this.message;
      } catch (error) {
        this.logger.warn(`Configured dashboard message ${existingId} was not found; creating a new one.`);
      }
    }

    this.message = await channel.send({
      embeds: [this.buildEmbed()],
      components: this.buildComponents()
    });

    if (!this.config.discord.dashboard_message_id) {
      writeJsonFile(this.config.paths.dashboard_message, {
        channel_id: channel.id,
        message_id: this.message.id
      });
    }
    return this.message;
  }

  async refresh() {
    if (!this.ready || this.refreshing) return;
    this.refreshing = true;
    try {
      const cashoutTarget = this.config.cashout_nickname || '';
      if (cashoutTarget) {
        const result = await this.manager.donutApi.getBalance(cashoutTarget, { botKey: 'dashboard', displayName: 'Dashboard' });
        if (result.ok && Number.isFinite(result.balance)) {
          this.targetBalanceLabel = `$${formatCompactMoney(result.balance)}`;
          this.targetBalanceAt = Date.now();
        } else {
          const gameResult = isTransientDashboardBalanceApiError(result)
            ? await this.manager.getGameBalanceForTarget(cashoutTarget)
            : null;
          if (gameResult && gameResult.ok && Number.isFinite(gameResult.balance)) {
            this.targetBalanceLabel = `$${formatCompactMoney(gameResult.balance)}`;
            this.targetBalanceAt = Date.now();
            this.logger.info(`Cashout target balance from game command: ${cashoutTarget} ${this.targetBalanceLabel}`);
          } else if (!this.hasCachedTargetBalanceFor(result)) {
            this.targetBalanceLabel = '?';
          } else {
            this.logger.debug(`Keeping cached cashout target balance during ${result.code || 'API error'}`);
          }
        }
      } else {
        this.targetBalanceLabel = '-';
        this.targetBalanceAt = 0;
      }

      if (!this.message) await this.ensureDashboardMessage();
      await this.message.edit({
        embeds: [this.buildEmbed()],
        components: this.buildComponents()
      });
    } catch (e) {
      if (e.code === 'UND_ERR_CONNECT_TIMEOUT' || e.message?.includes('Timeout') || e.code === 'ECONNRESET') return;
      this.logger.warn('Dashboard refresh failed', e);
    } finally {
      this.refreshing = false;
    }
  }

  buildEmbed() {
    const snapshots = this.manager.getSnapshots();
    const online = snapshots.filter((bot) => bot.online).length;
    const paused = snapshots.filter((bot) => bot.paused).length;

    let totalPerHour = 0;
    let totalBalance = 0;
    for (const controller of this.manager.controllers) {
      const visibleRate = Number(controller.shortPerHour) || Number(controller.currentPerHour) || 0;
      if (visibleRate) {
        totalPerHour += visibleRate;
      }
      if (controller.lastBalance != null) {
        totalBalance += controller.lastBalance;
      }
    }
    let lines = snapshots
      .filter((bot) => bot.balance !== '-')
      .slice(0, 45)
      .map((bot) => {
        const icon = bot.online ? (bot.paused ? '🟡' : '🟢') : '🔴';
        const hunger = bot.hunger || '-/20';
        const balance = this.compactDashboardMoney(bot.balance);
        const nextReconnect = bot.nextReconnectAt ? `<t:${Math.floor(bot.nextReconnectAt / 1000)}:R>` : '`-`';
        return `• ${icon} \`${bot.name}\` 🍗 \`${hunger}\` ♻️ ${nextReconnect} 💰 \`${balance}\` 📈 \`${bot.income}\` 🪓 ${bot.axe}`;
      })
      .join('\n');

    if (!lines) lines = '• No bots configured in fleet.';
    if (snapshots.length > 45) lines += `\n... and ${snapshots.length - 45} more`;

    const ts = Math.floor(Date.now() / 1000);
    const desc = `${lines}\n\n**Updated:** <t:${ts}:R>`;
    const cashoutTarget = this.config.cashout_nickname || 'None';
    const targetBalanceStr = this.targetBalanceLabel && this.targetBalanceLabel !== '-' ? ` (${this.targetBalanceLabel})` : '';

    const embed = new EmbedBuilder()
      .setTitle('WHeadless Control Center')
      .setColor(paused ? 0xf59e0b : 0x2f855a)
      .setDescription(desc)
      .addFields(
        { name: 'Accounts', value: String(snapshots.length), inline: true },
        { name: 'Online', value: String(online), inline: true },
        { name: 'Paused', value: String(paused), inline: true },
        { name: 'Total Balance', value: `💰 $${formatCompactMoney(totalBalance)}`, inline: true },
        { name: 'Total Income', value: `📈 $${formatCompactMoney(totalPerHour)}/h ($${formatCompactMoney(totalPerHour * 24)}/d)`, inline: true },
        { name: 'Cashout Target', value: `🎯 \`${cashoutTarget}\`${targetBalanceStr}`, inline: true }
      );

    return embed;
  }

  compactDashboardMoney(value) {
    const number = Number(String(value || '').replace(/[$,\s]/g, ''));
    return Number.isFinite(number) ? formatCompactMoney(number) : value;
  }

  hasCachedTargetBalanceFor(result) {
    if (!isTransientDashboardBalanceApiError(result)) return false;
    if (!this.targetBalanceLabel || this.targetBalanceLabel === '-' || this.targetBalanceLabel === '?') return false;
    const cachedAt = Number(this.targetBalanceAt) || 0;
    if (!cachedAt) return false;
    const maxAgeMs = dashboardBalanceCacheMaxAgeMs(this.config);
    return Date.now() - cachedAt <= maxAgeMs;
  }

  buildFarmCoordsText() {
    const snapshots = this.manager.getSnapshots();
    const lines = snapshots.map((bot) => {
      const icon = bot.online ? '🟢' : '🔴';
      const farm = bot.farm || {};
      const botPos = this.formatVector(farm.bot);
      const target = farm.target || null;
      const targetPos = target && target.position ? `${target.name || 'block'} ${this.formatVector(target.position)}` : '-';
      const seen = target && target.at ? `<t:${Math.floor(target.at / 1000)}:R>` : '-';
      return `• ${icon} \`${bot.name}\` Bot: \`${botPos}\` Target: \`${targetPos}\` Seen: ${seen}`;
    });
    return ['**Farm Coordinates**', lines.length ? lines.join('\n') : 'No bots configured.'].join('\n').slice(0, 1900);
  }

  formatVector(position) {
    if (!position) return '-';
    const x = Number(position.x);
    const y = Number(position.y);
    const z = Number(position.z);
    if (![x, y, z].every(Number.isFinite)) return '-';
    return `${x}, ${y}, ${z}`;
  }

  buildComponents() {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(BUTTONS.refresh).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('dashboard:manage_bot').setLabel('Manage Bots').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('dashboard:script_logs').setLabel('Script Logs').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(BUTTONS.farmCoords).setLabel('Farm Coords').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('dashboard:set_cashout').setLabel('Set Target').setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('dashboard:whitelist').setLabel('Whitelist').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(BUTTONS.cashoutAll).setLabel('Cashout All').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(BUTTONS.pause).setLabel('Pause').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(BUTTONS.resume).setLabel('Resume').setStyle(ButtonStyle.Success)
      )
    ];
  }

  async sendAlert(message) {
    if (!this.ready) {
      this.logger.warn('Discord alert before ready', message);
      return;
    }
    try {
      const channel = await this.client.channels.fetch(this.config.discord.log_channel_id);
      if (!channel || !channel.isTextBased()) throw new Error('log channel is not text based');
      const mention = this.config.discord.alert_mention ? `${this.config.discord.alert_mention} ` : '';
      await channel.send({
        content: `${mention}${message}`,
        allowedMentions: { parse: ['users', 'roles'] }
      });
    } catch (error) {
      if (error.code === 'UND_ERR_CONNECT_TIMEOUT' || error.message?.includes('Timeout') || error.code === 'ECONNRESET') return;
      this.logger.warn('Failed to send Discord alert', error);
    }
  }
}

function isTransientDashboardBalanceApiError(result) {
  if (!result || result.ok) return false;
  const code = String(result.code || '');
  return code === 'API_ERROR' || /^HTTP_5\d\d$/.test(code);
}

function dashboardBalanceCacheMaxAgeMs(config) {
  const configured = Number(config && config.bot_defaults && config.bot_defaults.cashout_balance_cache_max_age_ms);
  return Number.isFinite(configured) ? Math.max(0, configured) : 60 * 60 * 1000;
}

module.exports = {
  Dashboard
};
