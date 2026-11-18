import path from 'node:path';
import { GrammyError } from 'grammy';
import { run } from '@grammyjs/runner';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { ALLOWED_UPDATES, createBot, createStats, createTelegramDownloader } from './bot.js';
import { BOT_COMMANDS } from './handlers/commands.js';
import { OWNER_COMMANDS } from './handlers/admin.js';
import { Store } from './lib/db.js';
import { DEFAULT_TRACKERS, MetadataFetcher } from './lib/metadata.js';
import { JobLimiter } from './lib/limiter.js';
import * as texts from './texts.js';
import { APP_VERSION } from './version.js';

const rootDir = path.resolve(import.meta.dirname, '..');

// Load .env from the project folder (works no matter where pm2 starts us from).
// Variables that are already set in the environment take precedence.
try {
  process.loadEnvFile(path.join(rootDir, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.error(`Could not read .env: ${err.message}`);
    process.exit(1);
  }
}

let config;
try {
  config = loadConfig(process.env, { rootDir });
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`Configuration problem:\n${err.problems.map((p) => `  • ${p}`).join('\n')}`);
  process.exit(1);
}

const logger = createLogger(config.logLevel);
config.warnings.forEach((w) => logger.warn(w));
if (!config.ownerId) logger.warn('OWNER_ID is not set: /stats and /broadcast are disabled.');

process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection', reason));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception, exiting', err);
  process.exit(1);
});

const store = new Store(path.join(config.dataDir, 'bot.db'));
const fetcher = new MetadataFetcher({
  logger,
  dhtPort: config.dhtPort,
  trackers: [...config.extraTrackers, ...DEFAULT_TRACKERS],
  stateFile: path.join(config.dataDir, 'dht-state.json'),
});
const limiter = new JobLimiter({ concurrency: config.maxConcurrentJobs, perUser: config.maxJobsPerUser });
const stats = createStats();
const { bot, converter, logChannel, broadcaster } = createBot({
  config,
  fetcher,
  limiter,
  stats,
  logger,
  store,
  downloadFile: createTelegramDownloader(config.botToken),
});

try {
  await bot.init();
} catch (err) {
  if (err instanceof GrammyError && err.error_code === 401) {
    logger.error('Telegram rejected BOT_TOKEN (401 Unauthorized). Check the token in .env.');
  } else {
    logger.error('Could not connect to Telegram', err);
  }
  process.exit(1);
}

await fetcher.start();

// Polling and webhooks are mutually exclusive; make sure polling works.
await bot.api.deleteWebhook().catch((err) => logger.warn(`deleteWebhook failed: ${err.message}`));
await bot.api.setMyCommands(BOT_COMMANDS).catch((err) => logger.warn(`setMyCommands failed: ${err.message}`));
if (config.ownerId) {
  // The owner also sees the admin commands in their command menu.
  await bot.api
    .setMyCommands([...BOT_COMMANDS, ...OWNER_COMMANDS], { scope: { type: 'chat', chat_id: config.ownerId } })
    .catch(() => logger.debug('Owner command menu not set (start the bot from your account once).'));
}

// The runner processes updates concurrently, so one slow conversion never
// blocks everybody else.
const runner = run(bot, {
  runner: {
    fetch: { allowed_updates: ALLOWED_UPDATES },
    retryInterval: 3_000, // network trouble: retry every 3 s (no ever-growing backoff)
  },
});
logger.info(`@${bot.botInfo.username} is running (TorrentConverter v${APP_VERSION}, Node ${process.version})`);
logChannel.send(texts.logStarted(bot.botInfo.username, store.counts()));
broadcaster.resume();

let stopping = false;
async function shutdown(reason, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  logger.info(`Shutting down (${reason})…`);
  setTimeout(() => process.exit(exitCode || 1), 9_000).unref(); // never hang forever
  converter.abortAll();
  try {
    await broadcaster.stop(); // progress is saved; it resumes on next start
    await runner.stop(); // stops fetching updates…
    // …but doesn't wait for handlers that are still running: let them finish
    // (aborted conversions tell their users the bot is restarting).
    const deadline = Date.now() + 6_000;
    while (runner.size() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await logChannel.close();
    await fetcher.destroy();
    store.close();
  } catch (err) {
    logger.error('Error during shutdown', err);
  }
  process.exit(exitCode);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
// If polling stops for good (e.g. the token was revoked, or another instance is
// polling with the same token), exit so pm2 restarts us instead of idling.
runner.task()?.then(
  () => shutdown('polling stopped unexpectedly', 1),
  (err) => {
    if (err instanceof GrammyError && err.error_code === 409) {
      logger.error('Another process is already polling with this BOT_TOKEN (409 Conflict). Stop the old bot (pm2 ls) and keep only one running.');
    } else if (err instanceof GrammyError && err.error_code === 401) {
      logger.error('Telegram rejected BOT_TOKEN (401 Unauthorized). Was the token revoked in @BotFather?');
    } else {
      logger.error('Polling failed', err);
    }
    shutdown('polling failed', 1);
  },
);
