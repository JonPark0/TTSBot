import { Readable } from 'node:stream';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { synthesize } from '../tts/cloudflare.js';
import { canSpend, addUsage } from '../store.js';

/**
 * Owns the voice connection, audio player and message queue for a single guild.
 */
class GuildVoice {
  constructor(guild) {
    this.guild = guild;
    this.queue = [];
    this.connection = null;
    this.channelId = null;
    this.busy = false;
    this.idleTimer = null;

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.player.on('error', (err) => {
      logger.error(`[voice:${this.guild.id}] player error: ${err.message}`);
      this.busy = false;
      this.#drain();
    });
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.busy = false;
      this.#drain();
    });
  }

  enqueue(job) {
    if (this.queue.length >= config.queueMax) {
      logger.warn(`[voice:${this.guild.id}] queue full (${config.queueMax}), dropping message`);
      return false;
    }
    this.queue.push(job);
    this.#drain();
    return true;
  }

  async #drain() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) {
      this.#scheduleIdleLeave();
      return;
    }
    this.#clearIdleTimer();
    this.busy = true;

    try {
      const { voiceChannel, text, lang } = job;

      if (!voiceChannel || !voiceChannel.joinable) {
        logger.debug(`[voice:${this.guild.id}] target channel not joinable, skipping job`);
        this.busy = false;
        return this.#drain();
      }

      if (!canSpend(text.length)) {
        logger.warn(
          `[voice:${this.guild.id}] daily TTS character budget exhausted — clearing queue until reset`,
        );
        this.queue.length = 0;
        this.busy = false;
        return this.#drain();
      }

      const audio = await synthesize(text, lang);
      addUsage(text.length);

      await this.#ensureConnection(voiceChannel);

      const resource = createAudioResource(Readable.from(audio), {
        inputType: StreamType.Arbitrary,
      });
      this.player.play(resource);
      // The 'Idle' / 'error' handlers advance the queue from here.
    } catch (err) {
      logger.error(`[voice:${this.guild.id}] TTS job failed: ${err.message}`);
      this.busy = false;
      return this.#drain();
    }
  }

  async #ensureConnection(voiceChannel) {
    if (
      this.connection &&
      this.channelId === voiceChannel.id &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
      return this.connection;
    }

    if (this.connection && this.channelId !== voiceChannel.id) {
      try {
        this.connection.destroy();
      } catch {
        /* already gone */
      }
      this.connection = null;
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      try {
        connection.destroy();
      } catch {
        /* noop */
      }
      throw new Error(`voice connection did not become ready: ${err.message}`);
    }

    connection.subscribe(this.player);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        try {
          connection.destroy();
        } catch {
          /* noop */
        }
        if (this.connection === connection) {
          this.connection = null;
          this.channelId = null;
        }
      }
    });

    this.connection = connection;
    this.channelId = voiceChannel.id;
    return connection;
  }

  #scheduleIdleLeave() {
    this.#clearIdleTimer();
    if (!this.connection) return;
    this.idleTimer = setTimeout(() => {
      logger.info(`[voice:${this.guild.id}] idle timeout — leaving voice channel`);
      this.destroy();
    }, config.idleTimeoutMs);
  }

  #clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  destroy() {
    this.#clearIdleTimer();
    this.queue.length = 0;
    this.busy = false;
    try {
      this.player.stop(true);
    } catch {
      /* noop */
    }
    try {
      this.connection?.destroy();
    } catch {
      /* noop */
    }
    this.connection = null;
    this.channelId = null;
  }
}

const registry = new Map();

export function getGuildVoice(guild) {
  let gv = registry.get(guild.id);
  if (!gv) {
    gv = new GuildVoice(guild);
    registry.set(guild.id, gv);
  }
  return gv;
}

export function destroyAll() {
  for (const gv of registry.values()) gv.destroy();
  registry.clear();
}
