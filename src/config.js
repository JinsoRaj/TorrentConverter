import path from 'node:path';

export class ConfigError extends Error {
  name = 'ConfigError';
  constructor(problems) {
    super(problems.join('\n'));
    this.problems = problems;
  }
}

/**
 * Read and validate configuration from environment variables.
 * Variables from v1 (`BOT_TOKEN`, `OWNER_ID`) keep working unchanged.
 */
export function loadConfig(env, { rootDir }) {
  const problems = [];
  const warnings = [];

  const botToken = (env.BOT_TOKEN ?? '').trim();
  if (!botToken) {
    problems.push('BOT_TOKEN is not set. Create a bot with @BotFather and put its token in .env (see .env.example).');
  } else if (!/^\d+:[\w-]{20,}$/.test(botToken)) {
    problems.push('BOT_TOKEN looks invalid. It should look like 123456789:AAH4k... (copy it again from @BotFather).');
  }

  let ownerId;
  const rawOwner = (env.OWNER_ID ?? '').trim();
  if (rawOwner) {
    if (/^\d+$/.test(rawOwner)) ownerId = Number(rawOwner);
    else warnings.push(`OWNER_ID "${rawOwner}" is not a numeric Telegram user id; /stats is disabled.`);
  }

  const int = (name, fallback, min, max) => {
    const raw = (env[name] ?? '').trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number between ${min} and ${max} (got "${raw}").`);
      return fallback;
    }
    return value;
  };

  const extraTrackers = (env.EXTRA_TRACKERS ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const url of extraTrackers) {
    if (!/^(udp|https?):\/\/[^/]/i.test(url)) warnings.push(`EXTRA_TRACKERS: ignoring unsupported tracker "${url}".`);
  }

  const logLevel = (env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    problems.push(`LOG_LEVEL must be one of debug, info, warn, error (got "${env.LOG_LEVEL}").`);
  }

  let logChatId;
  const rawLogChat = (env.LOG_CHAT_ID ?? '').trim();
  if (rawLogChat) {
    if (/^-?\d+$/.test(rawLogChat)) logChatId = Number(rawLogChat);
    else warnings.push(`LOG_CHAT_ID "${rawLogChat}" is not a numeric chat id (like -1001234567890); logging to Telegram is disabled.`);
  }

  const metadataTimeoutSeconds = int('METADATA_TIMEOUT', 60, 10, 600);
  const broadcastRate = int('BROADCAST_RATE', 20, 1, 30);
  const maxConcurrentJobs = int('MAX_CONCURRENT_JOBS', 5, 1, 100);
  const maxJobsPerUser = int('MAX_JOBS_PER_USER', 2, 1, 50);
  const dhtPort = int('DHT_PORT', 0, 0, 65535);

  if (problems.length) throw new ConfigError(problems);

  return {
    botToken,
    ownerId,
    logChatId,
    broadcastRate,
    metadataTimeoutMs: metadataTimeoutSeconds * 1000,
    maxConcurrentJobs,
    maxJobsPerUser,
    maxMagnetsPerMessage: 5,
    maxTorrentBytes: 20 * 1024 * 1024, // Bot API download limit
    dhtPort,
    extraTrackers: extraTrackers.filter((url) => /^(udp|https?):\/\/[^/]/i.test(url)),
    logLevel,
    dataDir: path.resolve(rootDir, (env.DATA_DIR ?? '').trim() || 'data'),
    warnings,
  };
}
