'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { Manager } = require('./manager');

const logger = createLogger('main');
let manager = null;

async function main() {
  const config = loadConfig();
  manager = new Manager(config, logger);
  await manager.start();
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
});

async function shutdown(signal) {
  logger.info(`Received ${signal}`);
  try {
    if (manager) await manager.shutdown();
  } catch (error) {
    logger.error('Shutdown failed', error);
  } finally {
    process.exit(0);
  }
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error) => {
  logger.error('Startup failed', error);
  process.exitCode = 1;
});
