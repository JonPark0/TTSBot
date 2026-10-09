import { Readable } from 'node:stream';
import type { Guild, VoiceBasedChannel } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  NoSubscriberBehavior,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { synthesize, SkipError } from '../tts/index.ts';
import { canSpend, addUsage } from '../store.ts';

interface TtsJob {
  voiceChannel: VoiceBasedChannel;
  text: string;
  lang: string;
}

/**
 * Owns the voice connection, audio player and message queue for a single guild.
 */
class GuildVoice {
  guild: Guild;
  queue: TtsJob[];
  connection: VoiceConnection | null;
  channelId: string | null;
  busy: boolean;
  idleTimer: NodeJS.Timeout | null;
  player: AudioPlayer;

  constructor(guild: Guild) {
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

  enqueue(job: TtsJob): boolean {
    if (this.queue.length >= config.queueMax) {
      logger.warn(`[voice:${this.guild.id}] queue full (${config.queueMax}), dropping message`);
      return false;
    }
    this.queue.push(job);
    this.#drain();
    return true;
  }

  async #drain(): Promise<void> {
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

      // The daily character budget protects the cloud providers' free tiers. The local card server
      // costs nothing, so with TTS_PROVIDER=local a spent budget only turns the cloud fallbacks off.
      const paid = canSpend(text.length);
      if (!paid && config.ttsProvider !== 'local') {
        logger.warn(
          `[voice:${this.guild.id}] daily TTS character budget exhausted — clearing queue until reset`,
        );
        this.queue.length = 0;
        this.busy = false;
        return this.#drain();
      }

      const { audio, provider } = await synthesize(text, lang, { paid });
      if (provider !== 'local') addUsage(text.length);

      await this.#ensureConnection(voiceChannel);

      // The per-language gains were measured on MeloTTS output (quiet Chinese); Gemini output
      // already peaks near full scale and would clip if boosted, and the local server peak-normalizes
      // its output, so both always play at 1.
      // Inline volume costs an extra PCM transform per frame, so only enable it when needed.
      const gain = provider === 'cloudflare' ? (config.langGain[lang] ?? 1) : 1;
      const resource = createAudioResource(Readable.from(audio), {
        inputType: StreamType.Arbitrary,
        inlineVolume: gain !== 1,
      });
      resource.volume?.setVolume(gain);
      this.player.play(resource);
      // The 'Idle' / 'error' handlers advance the queue from here.
    } catch (err) {
      if (err instanceof SkipError) logger.debug(`[voice:${this.guild.id}] ${err.message}`);
      else logger.error(`[voice:${this.guild.id}] TTS job failed: ${(err as Error).message}`);
      this.busy = false;
      return this.#drain();
    }
  }

  async #ensureConnection(voiceChannel: VoiceBasedChannel): Promise<VoiceConnection> {
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
      throw new Error(`voice connection did not become ready: ${(err as Error).message}`);
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

const registry = new Map<string, GuildVoice>();

export function getGuildVoice(guild: Guild): GuildVoice {
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
