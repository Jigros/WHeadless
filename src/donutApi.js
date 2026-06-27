'use strict';

const { findBalanceField, formatMoney, getByPath, safeStringify } = require('./utils');

const HTTP_FAILURE_LOG_COOLDOWN_MS = 15 * 60 * 1000;
const API_HEALTH_REPEAT_LOG_MS = 15 * 60 * 1000;
const TRANSIENT_HTTP_STATUS_MIN = 500;

class DonutApi {
  constructor(config, logger, options = {}) {
    this.config = config.donut_api;
    this.logger = logger;
    this.unauthorizedLogged = new Set();
    this.httpFailureLoggedAt = new Map();
    this.onHealthEvent = typeof options.onHealthEvent === 'function' ? options.onHealthEvent : null;
    this.health = {
      down: false,
      downAt: 0,
      lastOkAt: 0,
      lastNotifiedAt: 0,
      failureCount: 0,
      firstFailure: null,
      lastFailure: null
    };
  }

  hasApiKey() {
    return Boolean(String(this.config.api_key || '').trim());
  }

  shouldLogHttpFailure(botKey, status) {
    if (status < TRANSIENT_HTTP_STATUS_MIN) return true;

    const key = `${botKey}:${status}`;
    const now = Date.now();
    const lastLoggedAt = this.httpFailureLoggedAt.get(key) || 0;
    if (lastLoggedAt && now - lastLoggedAt < HTTP_FAILURE_LOG_COOLDOWN_MS) return false;

    this.httpFailureLoggedAt.set(key, now);
    return true;
  }

  clearHttpFailures(botKey) {
    const prefix = `${botKey}:`;
    for (const key of this.httpFailureLoggedAt.keys()) {
      if (key.startsWith(prefix)) this.httpFailureLoggedAt.delete(key);
    }
  }

  emitHealthEvent(event) {
    if (!this.onHealthEvent) return;
    try {
      const result = this.onHealthEvent(event);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => this.logger.warn(`Donut API health event handler failed: ${error.message || error}`));
      }
    } catch (error) {
      this.logger.warn(`Donut API health event handler failed: ${error.message || error}`);
    }
  }

  recordHealthFailure(details = {}) {
    const now = Date.now();
    const failure = {
      at: now,
      code: details.code || (details.status ? `HTTP_${details.status}` : 'API_ERROR'),
      status: Number.isInteger(details.status) ? details.status : null,
      statusText: String(details.statusText || ''),
      displayName: String(details.displayName || ''),
      username: String(details.username || ''),
      url: String(details.url || ''),
      message: String(details.message || '')
    };

    if (!this.health.down) {
      this.health.down = true;
      this.health.downAt = now;
      this.health.lastNotifiedAt = now;
      this.health.failureCount = 1;
      this.health.firstFailure = failure;
      this.health.lastFailure = failure;
      this.emitHealthEvent({
        type: 'down',
        at: now,
        downAt: now,
        lastOkAt: this.health.lastOkAt,
        durationMs: 0,
        failureCount: this.health.failureCount,
        firstFailure: this.health.firstFailure,
        lastFailure: this.health.lastFailure
      });
      return;
    }

    this.health.failureCount += 1;
    this.health.lastFailure = failure;
    if (now - this.health.lastNotifiedAt >= API_HEALTH_REPEAT_LOG_MS) {
      this.health.lastNotifiedAt = now;
      this.emitHealthEvent({
        type: 'still_down',
        at: now,
        downAt: this.health.downAt,
        lastOkAt: this.health.lastOkAt,
        durationMs: now - this.health.downAt,
        failureCount: this.health.failureCount,
        firstFailure: this.health.firstFailure,
        lastFailure: this.health.lastFailure
      });
    }
  }

  recordHealthSuccess(details = {}) {
    const now = Date.now();
    const previousOkAt = this.health.lastOkAt;
    this.health.lastOkAt = now;
    if (!this.health.down) return;

    const event = {
      type: 'recovered',
      at: now,
      downAt: this.health.downAt,
      lastOkAt: previousOkAt,
      durationMs: now - this.health.downAt,
      failureCount: this.health.failureCount,
      firstFailure: this.health.firstFailure,
      lastFailure: this.health.lastFailure,
      recovery: {
        at: now,
        code: 'OK',
        status: Number.isInteger(details.status) ? details.status : 200,
        displayName: String(details.displayName || ''),
        username: String(details.username || ''),
        url: String(details.url || '')
      }
    };

    this.health.down = false;
    this.health.downAt = 0;
    this.health.lastNotifiedAt = 0;
    this.health.failureCount = 0;
    this.health.firstFailure = null;
    this.health.lastFailure = null;
    this.emitHealthEvent(event);
  }

  async getBalance(username, options = {}) {
    const displayName = options.displayName || username;
    const botKey = options.botKey || username;
    if (!this.hasApiKey()) {
      return {
        ok: false,
        code: 'NO_API_KEY',
        label: 'API key needed',
        balance: null
      };
    }

    const url = `${this.config.base_url}/${encodeURIComponent(username)}`;
    let response;
    let timeoutId = null;
    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 10000);
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.config.api_key}`,
          'x-api-key': this.config.api_key,
          Accept: 'application/json'
        },
        signal: controller.signal
      });
    } catch (error) {
      this.recordHealthFailure({
        code: 'API_ERROR',
        displayName,
        username,
        url,
        message: error && error.message ? error.message : String(error || 'network error')
      });
      return {
        ok: false,
        code: 'API_ERROR',
        label: 'API error',
        balance: null
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (response.status === 401) {
      if (!this.unauthorizedLogged.has(botKey)) {
        this.unauthorizedLogged.add(botKey);
        this.logger.warn(`Donut API unauthorized for ${displayName}. Check DONUT_API_KEY.`);
      }
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        label: 'API unauthorized',
        balance: null
      };
    }

    if (!response.ok) {
      if (response.status >= TRANSIENT_HTTP_STATUS_MIN) {
        this.recordHealthFailure({
          code: `HTTP_${response.status}`,
          status: response.status,
          statusText: response.statusText,
          displayName,
          username,
          url
        });
      }
      if (this.shouldLogHttpFailure(botKey, response.status)) {
        this.logger.warn(`Donut API returned HTTP ${response.status} for ${displayName}`);
      }
      return {
        ok: false,
        code: `HTTP_${response.status}`,
        label: response.status >= TRANSIENT_HTTP_STATUS_MIN ? 'API unavailable' : `API ${response.status}`,
        balance: null
      };
    }

    this.clearHttpFailures(botKey);

    let body;
    try {
      body = await response.json();
    } catch (error) {
      this.logger.warn(`Donut API JSON parse failed for ${displayName}`, error.message || error);
      return {
        ok: false,
        code: 'BAD_JSON',
        label: 'API parse error',
        balance: null
      };
    }

    const pathValue = this.config.balance_json_path ? getByPath(body, this.config.balance_json_path) : undefined;
    const balance = pathValue !== undefined ? Number(String(pathValue).replace(/[$,\s]/g, '')) : findBalanceField(body);
    if (!Number.isFinite(balance)) {
      this.logger.warn(`Donut API balance field not found for ${displayName}`, safeStringify(body, 500));
      return {
        ok: false,
        code: 'NO_BALANCE',
        label: 'Balance missing',
        balance: null
      };
    }

    this.recordHealthSuccess({
      status: response.status,
      displayName,
      username,
      url
    });

    return {
      ok: true,
      code: 'OK',
      label: formatMoney(balance),
      balance
    };
  }
}

module.exports = {
  DonutApi
};
