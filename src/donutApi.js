'use strict';

const { findBalanceField, formatMoney, getByPath, safeStringify } = require('./utils');

class DonutApi {
  constructor(config, logger) {
    this.config = config.donut_api;
    this.logger = logger;
    this.unauthorizedLogged = new Set();
  }

  hasApiKey() {
    return Boolean(String(this.config.api_key || '').trim());
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
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.config.api_key}`,
          'x-api-key': this.config.api_key,
          Accept: 'application/json'
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
    } catch (error) {
      // Игнорируем сетевые ошибки (таймауты/обрывы), так как баланс обновится в следующем цикле
      return {
        ok: false,
        code: 'API_ERROR',
        label: 'API error',
        balance: null
      };
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
      this.logger.warn(`Donut API returned HTTP ${response.status} for ${displayName}`);
      return {
        ok: false,
        code: `HTTP_${response.status}`,
        label: `API ${response.status}`,
        balance: null
      };
    }

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
