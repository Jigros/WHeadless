'use strict';

const net = require('node:net');
const tls = require('node:tls');
const { SocksClient } = require('socks');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

function normalizeProxyConfig(proxy) {
  if (!proxy) return null;
  const host = String(proxy.host || proxy.ip || '').trim();
  const port = Number(proxy.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  const type = String(proxy.type || proxy.protocol || 'socks5').toLowerCase().replace(':', '');
  return {
    type,
    host,
    port,
    username: proxy.username ? String(proxy.username) : '',
    password: proxy.password ? String(proxy.password) : '',
    public_ip: proxy.public_ip ? String(proxy.public_ip) : '',
    label: proxy.label ? String(proxy.label) : ''
  };
}

function getProxyLabel(proxy) {
  if (!proxy) return 'direct';
  return proxy.label || proxy.public_ip || proxy.host || 'proxy';
}

function proxyUrl(proxy) {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

function createHttpAgent(proxy) {
  if (!proxy) return null;
  if (proxy.type.startsWith('socks')) return new SocksProxyAgent(proxyUrl(proxy));
  if (proxy.type === 'http' || proxy.type === 'https') return new HttpsProxyAgent(proxyUrl(proxy));
  return null;
}

function createMineflayerConnect(proxy, targetHost, targetPort, logger) {
  if (!proxy) return undefined;
  if (proxy.type.startsWith('socks')) {
    return (client) => connectViaSocks(client, proxy, targetHost, targetPort, logger);
  }
  if (proxy.type === 'http' || proxy.type === 'https') {
    return (client) => connectViaHttpConnect(client, proxy, targetHost, targetPort, logger);
  }
  throw new Error(`Unsupported proxy type: ${proxy.type}`);
}

async function connectViaSocks(client, proxy, targetHost, targetPort, logger) {
  try {
    const type = proxy.type === 'socks4' ? 4 : 5;
    const result = await SocksClient.createConnection({
      command: 'connect',
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type,
        userId: proxy.username || undefined,
        password: proxy.password || undefined
      },
      destination: {
        host: targetHost,
        port: targetPort
      },
      timeout: 30000
    });
    attachSocket(client, result.socket);
  } catch (error) {
    logger.warn('SOCKS proxy connection failed', error);
    client.emit('error', error);
  }
}

function connectViaHttpConnect(client, proxy, targetHost, targetPort, logger) {
  const socketFactory = proxy.type === 'https' ? tls.connect : net.connect;
  const socket = socketFactory({
    host: proxy.host,
    port: proxy.port,
    servername: proxy.type === 'https' ? proxy.host : undefined,
    timeout: 30000
  });

  let buffer = Buffer.alloc(0);

  socket.once('connect', () => {
    const authHeader = proxy.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}\r\n`
      : '';
    socket.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        authHeader +
        'Proxy-Connection: Keep-Alive\r\n' +
        '\r\n'
    );
  });

  socket.on('data', function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf('\r\n\r\n');
    if (end === -1) return;

    socket.off('data', onData);
    const header = buffer.slice(0, end).toString('utf8');
    const status = header.match(/^HTTP\/\d\.\d\s+(\d+)/i);
    if (!status || Number(status[1]) < 200 || Number(status[1]) >= 300) {
      const error = new Error(`HTTP proxy CONNECT failed: ${header.split('\r\n')[0] || 'unknown response'}`);
      logger.warn(error.message);
      socket.destroy(error);
      client.emit('error', error);
      return;
    }

    const rest = buffer.slice(end + 4);
    if (rest.length) socket.unshift(rest);
    attachSocket(client, socket);
  });

  socket.once('timeout', () => {
    const error = new Error('Proxy CONNECT timed out');
    socket.destroy(error);
    client.emit('error', error);
  });

  socket.once('error', (error) => {
    logger.warn('HTTP proxy connection failed', error);
    client.emit('error', error);
  });
}

function attachSocket(client, socket) {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30000);
  client.setSocket(socket);
  client.emit('connect');
}

module.exports = {
  createHttpAgent,
  createMineflayerConnect,
  getProxyLabel,
  normalizeProxyConfig
};
