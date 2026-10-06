import { Client, GatewayIntentBits, Events, MessageFlags } from 'discord.js';
import { config } from './config.ts';
import { logger } from './logger.ts';
import { initStore, flushStore, getTtsChannel, canSpend } from './store.ts';
import { sanitize } from './text/sanitize.ts';
import { detectLang } from './text/langDetect.ts';
import { getGuildVoice, destroyAll } from './voice/voiceManager.ts';
import { registerForGuild, clearGlobalCommands, handleInteraction } from './commands.ts';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged — enable it in the Developer Portal
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  logger.info(`[bot] logged in as ${readyClient.user.tag}`);
  try {
    const removed = await clearGlobalCommands();
    if (removed > 0) logger.info(`[bot] removed ${removed} stale global command(s)`);
  } catch (err) {
    logger.warn(`[bot] clearing global commands failed: ${(err as Error).message}`);
  }
  let registered = 0;
  for (const [guildId, guild] of readyClient.guilds.cache) {
    try {
      await registerForGuild(guildId);
      registered++;
      logger.debug(`[bot] registered commands for ${guild.name} (${guildId})`);
    } catch (err) {
      const { code, status, message } = err as Error & { code?: unknown; status?: unknown };
      logger.warn(
        `[bot] command registration failed for ${guild.name} (${guildId}): ` +
          `[${code ?? status ?? '?'}] ${message}`,
      );
    }
  }
  logger.info(
    `[bot] slash commands registered in ${registered}/${readyClient.guilds.cache.size} guild(s)`,
  );
  logger.info(`[bot] ready in ${readyClient.guilds.cache.size} guild(s)`);
});

client.on(Events.GuildCreate, async (guild) => {
  try {
    await registerForGuild(guild.id);
    logger.info(`[bot] joined ${guild.name} — commands registered`);
  } catch (err) {
    logger.warn(`[bot] command registration on join failed: ${(err as Error).message}`);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (err) {
    logger.error(`[bot] interaction error: ${(err as Error).message}`);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      interaction
        .reply({ content: '오류가 발생했습니다.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.inGuild()) return;
    if (message.author.bot || message.webhookId) return;
    if (message.system) return;

    const ttsChannelId = getTtsChannel(message.guildId);
    if (!ttsChannelId || message.channelId !== ttsChannelId) return;

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      logger.debug(`[bot] ${message.author.tag} is not in a voice channel — skipping`);
      return;
    }

    const me = message.guild.members.me;
    if (!me || !voiceChannel.permissionsFor(me)?.has(['Connect', 'Speak'])) {
      logger.warn(`[bot] missing Connect/Speak permission in "${voiceChannel.name}"`);
      return;
    }

    const text = sanitize(message.content, { message });
    if (!text) return;

    if (!canSpend(text.length)) {
      logger.debug('[bot] daily TTS budget exhausted — skipping message');
      return;
    }

    const lang = detectLang(text, config.defaultLang);
    logger.info(
      `[tts] ${message.guild.name} #${message.channel?.name} <${message.author.tag}> [${lang}] ${text}`,
    );

    getGuildVoice(message.guild).enqueue({ voiceChannel, text, lang });
  } catch (err) {
    logger.error(`[bot] message handler error: ${(err as Error).message}`);
  }
});

client.on(Events.Error, (err) => logger.error(`[bot] client error: ${err.message}`));
process.on('unhandledRejection', (reason) => logger.error(`[bot] unhandledRejection: ${reason}`));

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[bot] ${signal} received — shutting down`);
  try {
    destroyAll();
  } catch {
    /* noop */
  }
  await flushStore().catch(() => {});
  await client.destroy().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await initStore();
await client.login(config.discordToken);
