import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  REST,
  Routes,
} from 'discord.js';
import { config } from './config.js';
import { getTtsChannel, setTtsChannel, clearTtsChannel, usageInfo } from './store.js';

const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

export const commands = [
  new SlashCommandBuilder()
    .setName('tts-channel')
    .setDescription('TTS 채널을 관리합니다 (서버 관리 권한 필요)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('지정한 채널(미지정 시 현재 채널)을 TTS 채널로 설정합니다')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('TTS로 읽을 텍스트 채널')
            .addChannelTypes(...TEXT_CHANNEL_TYPES),
        ),
    )
    .addSubcommand((sub) => sub.setName('clear').setDescription('TTS 채널 설정을 해제합니다'))
    .addSubcommand((sub) => sub.setName('status').setDescription('현재 TTS 설정과 사용량을 표시합니다'))
    .toJSON(),
];

export async function registerForGuild(guildId) {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  await rest.put(Routes.applicationGuildCommands(config.discordClientId, guildId), { body: commands });
}

export async function registerGlobal() {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  await rest.put(Routes.applicationCommands(config.discordClientId), { body: commands });
}

export async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'tts-channel') return;

  if (!interaction.inGuild()) {
    return interaction.reply({
      content: '이 명령은 서버 안에서만 사용할 수 있습니다.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (sub === 'set') {
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    if (!channel || !TEXT_CHANNEL_TYPES.includes(channel.type)) {
      return interaction.reply({
        content: '일반 텍스트 채널만 TTS 채널로 지정할 수 있습니다.',
        flags: MessageFlags.Ephemeral,
      });
    }
    setTtsChannel(guildId, channel.id);
    return interaction.reply({
      content: `✅ 이제 <#${channel.id}> 채널의 메시지를 작성자의 음성 채널에서 읽어 줍니다.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'clear') {
    clearTtsChannel(guildId);
    return interaction.reply({
      content: '🛑 TTS 채널 설정을 해제했습니다.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'status') {
    const channelId = getTtsChannel(guildId);
    const usage = usageInfo();
    const lines = [
      channelId ? `• TTS 채널: <#${channelId}>` : '• TTS 채널: (설정되지 않음)',
      `• 감지 실패 시 기본 언어: ${config.defaultLang}`,
      `• 메시지 최대 길이: ${config.maxChars}자`,
      config.dailyCharLimit > 0
        ? `• 오늘 사용량(UTC): ${usage.chars.toLocaleString()} / ${usage.limit.toLocaleString()}자`
        : '• 일일 사용량 제한: 없음',
      `• 모델: \`${config.cfTtsModel}\``,
    ];
    return interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
  }
}
