import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

const FILE = path.join(config.dataDir, 'store.json');

let state = { guilds: {}, usage: { date: today(), chars: 0 } };
let writeTimer = null;
let canPersist = true;

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function rollDate() {
  const current = today();
  if (state.usage.date !== current) {
    state.usage = { date: current, chars: 0 };
    scheduleWrite();
  }
}

function scheduleWrite() {
  if (writeTimer || !canPersist) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    persistNow().catch((err) => logger.error(`[store] write failed: ${err.message}`));
  }, 300);
}

async function persistNow() {
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, FILE);
}

export async function initStore() {
  await fs.mkdir(config.dataDir, { recursive: true }).catch(() => {});
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = {
      guilds: parsed.guilds && typeof parsed.guilds === 'object' ? parsed.guilds : {},
      usage:
        parsed.usage && typeof parsed.usage === 'object'
          ? { date: String(parsed.usage.date || today()), chars: Number(parsed.usage.chars) || 0 }
          : { date: today(), chars: 0 },
    };
    logger.info(`[store] loaded ${Object.keys(state.guilds).length} guild config(s) from ${FILE}`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn(`[store] could not read ${FILE}: ${err.message} — starting fresh`);
    }
    try {
      await persistNow();
    } catch (writeErr) {
      canPersist = false;
      logger.warn(
        `[store] cannot write to ${FILE}: ${writeErr.message} — running in memory only ` +
          `(fix the permissions on the data directory to persist config)`,
      );
    }
  }
  rollDate();
}

export function getTtsChannel(guildId) {
  return state.guilds[guildId]?.ttsChannelId ?? null;
}

export function setTtsChannel(guildId, channelId) {
  state.guilds[guildId] = { ...(state.guilds[guildId] || {}), ttsChannelId: channelId };
  scheduleWrite();
}

export function clearTtsChannel(guildId) {
  if (state.guilds[guildId]?.ttsChannelId) {
    delete state.guilds[guildId].ttsChannelId;
    scheduleWrite();
  }
}

export function canSpend(chars) {
  rollDate();
  if (!config.dailyCharLimit || config.dailyCharLimit <= 0) return true;
  return state.usage.chars + chars <= config.dailyCharLimit;
}

export function addUsage(chars) {
  rollDate();
  state.usage.chars += chars;
  scheduleWrite();
}

export function usageInfo() {
  rollDate();
  return { date: state.usage.date, chars: state.usage.chars, limit: config.dailyCharLimit };
}

export async function flushStore() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!canPersist) return;
  try {
    await persistNow();
  } catch (err) {
    logger.warn(`[store] flush failed: ${err.message}`);
  }
}
