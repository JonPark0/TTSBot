import { config } from '../config.js';

const RE_CODE_BLOCK = /```[\s\S]*?```/g;
const RE_INLINE_CODE = /`([^`]*)`/g;
const RE_SPOILER = /\|\|[\s\S]*?\|\|/g; // hidden content — drop entirely
const RE_URL = /(?:https?:\/\/|www\.)[^\s<]+/gi;
const RE_DISCORD_TIMESTAMP = /<t:\d+(?::[tTdDfFR])?>/g;
const RE_CUSTOM_EMOJI = /<a?:(\w+):\d+>/g; // <:name:id> / <a:name:id>
const RE_USER_MENTION = /<@!?(\d+)>/g;
const RE_ROLE_MENTION = /<@&(\d+)>/g;
const RE_CHANNEL_MENTION = /<#(\d+)>/g;
const RE_BULK_MENTION = /@(everyone|here)/g;

// Unicode emoji, pictographs, flags, skin-tone modifiers, ZWJ, variation selectors, keycaps.
const RE_EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]|\uFE0F|\u20E3|\u200D/gu;

// Leftover markdown syntax after content has been preserved.
const RE_MARKDOWN = /(\*\*|\*|__|_|~~|`|^>\s?|^#{1,6}\s)/gm;

// Everything that is NOT a letter / mark / number / space / whitelisted punctuation
// gets replaced by a space. Covers stray special characters and odd unicode symbols.
const RE_DISALLOWED =
  /[^\p{L}\p{M}\p{N}\s.,!?…~\-'"():;%°/、。！？：；「」『』（）〜々ー]/gu;

const RE_WHITESPACE = /\s+/g;

function resolveMentions(text, message) {
  if (!message) {
    return text
      .replace(RE_USER_MENTION, ' ')
      .replace(RE_CHANNEL_MENTION, ' ')
      .replace(RE_ROLE_MENTION, ' ');
  }
  return text
    .replace(RE_USER_MENTION, (_, id) => {
      const member = message.mentions?.members?.get(id) || message.guild?.members?.cache.get(id);
      const user = message.mentions?.users?.get(id) || message.client?.users?.cache.get(id);
      const name = member?.displayName || user?.username;
      return name ? ` ${name} ` : ' ';
    })
    .replace(RE_CHANNEL_MENTION, (_, id) => {
      const channel = message.guild?.channels?.cache.get(id);
      return channel ? ` ${channel.name} ` : ' ';
    })
    .replace(RE_ROLE_MENTION, (_, id) => {
      const role = message.guild?.roles?.cache.get(id);
      return role ? ` ${role.name} ` : ' ';
    });
}

/**
 * Turn a raw Discord message into a clean string suitable for TTS.
 * Returns '' when nothing speakable remains.
 */
export function sanitize(content, { message } = {}) {
  let text = typeof content === 'string' ? content : '';
  if (!text) return '';

  text = text.replace(RE_CODE_BLOCK, ' ');
  text = text.replace(RE_INLINE_CODE, ' $1 ');
  text = text.replace(RE_SPOILER, ' ');
  text = text.replace(RE_URL, ' ');
  text = text.replace(RE_DISCORD_TIMESTAMP, ' ');

  text = resolveMentions(text, message);
  text = text.replace(RE_BULK_MENTION, ' ');

  text = text.replace(RE_CUSTOM_EMOJI, config.readCustomEmojiNames ? ' $1 ' : ' ');
  text = text.replace(RE_EMOJI, ' ');

  text = text.replace(RE_MARKDOWN, ' ');
  text = text.replace(RE_DISALLOWED, ' ');

  text = text.replace(RE_WHITESPACE, ' ').trim();

  if (config.maxChars > 0 && text.length > config.maxChars) {
    text = text.slice(0, config.maxChars).trim();
  }
  return text;
}
