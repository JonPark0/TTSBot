// Optional helper: register the slash commands globally, once.
// Usage:  npm run register
// (The bot also auto-registers per-guild on startup and when it joins a guild.)
import { registerGlobal } from './commands.js';
import { logger } from './logger.js';

registerGlobal()
  .then(() => {
    logger.info('[register] global slash commands registered');
    process.exit(0);
  })
  .catch((err) => {
    logger.error(`[register] failed: ${err.message}`);
    process.exit(1);
  });
