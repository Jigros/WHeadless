# Donut Headless Bot Manager

Production-focused Node.js 20+ infrastructure for managing multiple Microsoft Premium Mineflayer accounts on Donut SMP with one persistent Discord dashboard.

## Features

- Mineflayer Microsoft auth only (`auth: "microsoft"`) with `profilesFolder` cache for restarts.
- Minecraft version defaults to `1.21.11`.
- One global proxy or per-bot proxy; `host` is preferred and `ip` is accepted as an alias.
- Donut API balance polling with optional `DONUT_API_KEY`.
- Single Discord dashboard message with gated buttons.
- Minecart-aware farming loop using the original simple packet loop only.
- Axe detection, equip, self-destruct timer parsing, and critical alerts.
- Protocol diagnostics with recent inbound/outbound packet trace on disconnect.
- Resource pack denial and basic exploit packet protection.

## Setup

```bash
npm install
cp config.example.json config.json
cp .env.example .env
```

Edit `.env`:

```bash
DISCORD_TOKEN=your_discord_bot_token
DONUT_API_KEY=optional_donut_api_key
```

Edit `config.json`:

- Set `server.host` and `server.port`.
- Set `discord.dashboard_channel_id` and `discord.log_channel_id`.
- Set `cashout_nickname`.
- Add whitelisted Minecraft usernames to `whitelist`.
- Add Microsoft account usernames/emails in `bots`.
- Optionally set global `proxy` or each bot's `proxy`.

Run locally:

```bash
npm start
```

## VPS Deployment With systemd

`systemd` is the recommended production launcher on a VPS. It starts the bot after reboot, restarts it after crashes, and exposes logs through `journalctl`.

The examples below assume Ubuntu 22.04/24.04, project path `/opt/wheadless`, and Linux user `wheadless`.

### 1. Install system packages

Connect to the VPS:

```bash
ssh root@YOUR_VPS_IP
```

Install basics:

```bash
apt update
apt upgrade -y
apt install -y git curl build-essential
```

Install Node.js 22:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v
npm -v
```

### 2. Create a service user

```bash
adduser --system --group --home /opt/wheadless wheadless
```

### 3. Upload or clone the project

Recommended: keep the code in a private GitHub/GitLab repository.

```bash
git clone YOUR_PRIVATE_REPO_URL /opt/wheadless
cd /opt/wheadless
npm install
cp config.example.json config.json
cp .env.example .env
chown -R wheadless:wheadless /opt/wheadless
```

Edit secrets and bot settings:

```bash
nano /opt/wheadless/.env
nano /opt/wheadless/config.json
```

Do not commit these files to Git:

```text
.env
config.json
auth/
data/
logs/
node_modules/
```

### 4. Check before starting

```bash
cd /opt/wheadless
sudo -u wheadless npm run check
```

### 5. Create the systemd service

Create `/etc/systemd/system/wheadless.service`:

```bash
nano /etc/systemd/system/wheadless.service
```

Paste:

```ini
[Unit]
Description=WHeadless Donut Bot Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=wheadless
Group=wheadless
WorkingDirectory=/opt/wheadless
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=15
KillSignal=SIGTERM
TimeoutStopSec=60

# Basic hardening. Keep ReadWritePaths because the app writes auth/data/logs/config updates.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/wheadless

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable --now wheadless
systemctl status wheadless
```

### 6. Logs and operations

Live logs:

```bash
journalctl -u wheadless -f
```

Last 200 lines:

```bash
journalctl -u wheadless -n 200 --no-pager
```

Restart:

```bash
systemctl restart wheadless
```

Stop/start:

```bash
systemctl stop wheadless
systemctl start wheadless
```

Check if enabled after reboot:

```bash
systemctl is-enabled wheadless
```

### 7. Updating code on VPS

```bash
cd /opt/wheadless
git pull
npm install
npm run check
systemctl restart wheadless
```

If you changed only `config.json` or `.env`, restart is enough:

```bash
systemctl restart wheadless
```

### 8. Editing with VS Code and AI

Install VS Code extension `Remote - SSH`, then connect:

```text
root@YOUR_VPS_IP
```

Open folder:

```text
/opt/wheadless
```

Then use Copilot, Cursor, Codeium, Continue, or another AI assistant directly against the VPS files.

Recommended edit loop:

```bash
npm run check
systemctl restart wheadless
journalctl -u wheadless -f
```

### 9. First Microsoft login on VPS

Watch logs:

```bash
journalctl -u wheadless -f
```

When Discord/logs show Microsoft device code, open:

```text
https://www.microsoft.com/link
```

Enter the code. Auth tokens are cached in `auth/profiles`, so normal `systemctl restart wheadless` should reuse the session.

### 10. Optional firewall

If you only need SSH:

```bash
ufw allow OpenSSH
ufw enable
```

Make sure your VPS provider firewall also allows SSH.

### 11. Optional PM2 local run

PM2 can still be used for local testing, but `systemd` is preferred on VPS:

```bash
pm2 start ecosystem.config.cjs
pm2 logs donut-headless-bots
```

## First Microsoft Login

Each account uses official Microsoft authentication. The first login may require the browser/device-code flow in the terminal or Discord logs. Tokens are cached under `auth.profiles_folder`, so normal restarts reuse the profile cache.

## Dashboard

The dashboard edits one message in `discord.dashboard_channel_id`. If `discord.dashboard_message_id` is empty, the created message ID is stored in `data/dashboard-message.json`.

Buttons:

- Refresh
- Check All
- Cashout All
- Reconnect All
- Offline List
- Pause
- Resume

If `discord.allowed_user_ids` is non-empty, only those Discord user IDs can use the buttons.

The Manage Bots button opens a small control panel:

- select an existing bot or create a new one
- edit nickname, proxy, and proxy auth with separate buttons
- turn one bot ON/OFF
- remove proxy
- delete a bot after confirmation

New bots created from this panel are saved as `OFF` first. Fill in proxy/nickname, then press `ON` to start login.

The `/bot` slash command still exists as a fast fallback:

```text
/bot add username:account@example.com proxy:127.0.0.1:1080 proxy_auth:user:pass
/bot edit username:account@example.com proxy:none
/bot off username:account@example.com
/bot on username:account@example.com
/bot delete username:account@example.com
```

`proxy` accepts `host:port`, `host:port:user:pass`, or `none`. Existing bot usernames autocomplete in `/bot edit`, `/bot off`, `/bot on`, and `/bot delete`.

## Donut API

`DONUT_API_KEY` is optional. Without it, balance cells show `API key needed` and requests are skipped.

If Donut returns `401`, each bot logs one warning and shows `API unauthorized`.

Balance extraction uses `donut_api.balance_json_path` when set. Otherwise it recursively searches for `money`, `balance`, or `cash`.

## Proxy Format

Global proxy:

```json
{
  "proxy": {
    "type": "socks5",
    "host": "127.0.0.1",
    "port": 1080,
    "username": "",
    "password": "",
    "public_ip": "203.0.113.10"
  }
}
```

Per-bot proxy:

```json
{
  "username": "account@example.com",
  "proxy": {
    "type": "http",
    "host": "127.0.0.1",
    "port": 8080
  }
}
```

`public_ip` only changes the dashboard label. Use `host` for the real proxy host/IP; `ip` is accepted as an alias.

## Farming Behavior

On spawn, each bot waits `post_spawn_grace_ms`, sends `home_farm_command` when `spawn_home_enabled` is enabled, waits `spawn_home_wait_ms`, aligns to `server.target_cardinal_direction` and `server.pitch_degrees`, starts balance/axe polling, then farms only while holding a configured axe.

Home recovery watches recent farming actions first. When `home_recovery_ignore_passive_movement` is enabled, water/current movement does not count as recovery while the farming loop is active; the bot must actually attempt farming within `home_recovery_stuck_seconds`. Repeated Discord recovery notices are limited by `home_recovery_discord_cooldown_ms`. If chat reports maintenance/limbo, it retries `/home` with the configured retry delay until home succeeds.

Scheduled reconnect is enabled by default. Each bot reconnects after `scheduled_reconnect_interval_ms` (`24h`) plus up to `scheduled_reconnect_jitter_ms` (`30m`) so long-running sessions refresh without every account reconnecting at once. If a bot is eating, trading, respawning, or in home recovery, the scheduled reconnect is retried after `scheduled_reconnect_busy_retry_ms`.

The farming loop is intentionally simple:

- verify/equip axe
- `swingArm("right", true)`
- `blockAtCursor(farm_reach_blocks)`
- send `block_dig` start destroy packet
- send cancel destroy packet when stopping

No native dig mode, vanilla hold mode, target block filters, pitch/yaw sweeps, or experimental mechanics are included.

## Safety Pauses

Kick reasons containing `already online` pause reconnects as `Ghost Session / Manual Reset`.

Kick reasons containing `make a ticket` or `don't know what happened` pause reconnects as `Server Ticket / Manual Check`.

`reconnect_on_kick` defaults to `false`, so other kicks pause for diagnostics.

## Validation

Run syntax checks for all source files:

```bash
npm run check
```
