import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { logger } from './logger.ts';

const FILE = path.join(config.dataDir, 'store.json');

interface GuildConfig {
  ttsChannelId?: string;
}

interface Usage {
  date: string;
  chars: number;
  credits: number;
}

interface State {
  guilds: Record<string, GuildConfig>;
  usage: Usage;
}

// usage.credits counts Gemini (BAZE) TTS credits; it shares the UTC-day reset with chars.
let state: State = { guilds: {}, usage: emptyUsage() };
let writeTimer: NodeJS.Timeout | null = null;
let canPersist = true;

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function emptyUsage(date = today()): Usage {
  return { date, chars: 0, credits: 0 };
}

function rollDate() {
  const current = today();
  if (state.usage.date !== current) {
    state.usage = emptyUsage(current);
    scheduleWrite();
  }
}

function scheduleWrite() {
  if (writeTimer || !canPersist) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    persistNow().catch((err: Error) => logger.error(`[store] write failed: ${err.message}`));
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
          ? {
              date: String(parsed.usage.date || today()),
              chars: Number(parsed.usage.chars) || 0,
              credits: Number(parsed.usage.credits) || 0, // absent in store.json from older versions
            }
          : emptyUsage(),
    };
    logger.info(`[store] loaded ${Object.keys(state.guilds).length} guild config(s) from ${FILE}`);
  } catch (err) {
    const { code, message } = err as NodeJS.ErrnoException;
    if (code !== 'ENOENT') {
      logger.warn(`[store] could not read ${FILE}: ${message} — starting fresh`);
    }
    try {
      await persistNow();
    } catch (writeErr) {
      canPersist = false;
      logger.warn(
        `[store] cannot write to ${FILE}: ${(writeErr as Error).message} — running in memory only ` +
          `(fix the permissions on the data directory to persist config)`,
      );
    }
  }
  rollDate();
}

export function getTtsChannel(guildId: string): string | null {
  return state.guilds[guildId]?.ttsChannelId ?? null;
}

export function setTtsChannel(guildId: string, channelId: string) {
  state.guilds[guildId] = { ...(state.guilds[guildId] || {}), ttsChannelId: channelId };
  scheduleWrite();
}

export function clearTtsChannel(guildId: string) {
  if (state.guilds[guildId]?.ttsChannelId) {
    delete state.guilds[guildId].ttsChannelId;
    scheduleWrite();
  }
}

export function canSpend(chars: number): boolean {
  rollDate();
  if (!config.dailyCharLimit || config.dailyCharLimit <= 0) return true;
  return state.usage.chars + chars <= config.dailyCharLimit;
}

export function addUsage(chars: number) {
  rollDate();
  state.usage.chars += chars;
  scheduleWrite();
}

export function canSpendCredits(): boolean {
  rollDate();
  if (!config.bazeDailyCreditLimit || config.bazeDailyCreditLimit <= 0) return true;
  return state.usage.credits < config.bazeDailyCreditLimit;
}

export function addCredits(credits: number) {
  rollDate();
  state.usage.credits += credits;
  scheduleWrite();
}

export function usageInfo() {
  rollDate();
  return {
    date: state.usage.date,
    chars: state.usage.chars,
    limit: config.dailyCharLimit,
    credits: state.usage.credits,
    creditLimit: config.bazeDailyCreditLimit,
  };
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
    logger.warn(`[store] flush failed: ${(err as Error).message}`);
  }
}
