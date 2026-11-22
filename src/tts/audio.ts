/** Best-effort audio container detection from the first bytes (for logs and the probe script). */
export function sniff(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer.toString('ascii', 0, 3) === 'ID3') return 'mp3(ID3)';
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mp3(frame)';
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'RIFF') return 'wav';
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  return 'unknown';
}
