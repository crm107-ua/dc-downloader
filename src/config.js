const {
  resolveProviderByUrl,
  resolveProviderByHost,
  supportedLabelsForError,
  allHosts,
} = require('./providers');

function getConfig() {
  const maxDuration = Number(process.env.MAX_DURATION_SECONDS || 600);
  const maxFileSizeMb = Number(process.env.MAX_FILE_SIZE_MB || 10);
  const tempDir = process.env.TEMP_DIR || './temp';
  const tempMaxAgeHours = Number(process.env.TEMP_MAX_AGE_HOURS || 24);

  return {
    token: process.env.DISCORD_BOT_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    guildId: process.env.DISCORD_GUILD_ID || '',
    cookiesFile: process.env.COOKIES_FILE || '',
    cookiesFromBrowser: process.env.COOKIES_FROM_BROWSER || '',
    maxDurationSeconds: Number.isFinite(maxDuration) ? maxDuration : 600,
    maxFileSizeMb: Number.isFinite(maxFileSizeMb) ? maxFileSizeMb : 10,
    maxFileSizeBytes: Math.floor((Number.isFinite(maxFileSizeMb) ? maxFileSizeMb : 10) * 1024 * 1024),
    tempDir,
    tempMaxAgeHours: Number.isFinite(tempMaxAgeHours) && tempMaxAgeHours > 0 ? tempMaxAgeHours : 24,
  };
}

function parseAllowedUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('URL inválida.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('La URL debe usar http o https.');
  }

  const provider = resolveProviderByHost(parsed.hostname);
  if (!provider) {
    throw new Error(
      `Plataforma no soportada. Usa enlaces de: ${supportedLabelsForError()}.`
    );
  }

  return parsed.toString();
}

/** @deprecated Prefer resolveProviderByUrl — kept for callers that only need the id */
function detectPlatform(urlString) {
  const provider = resolveProviderByUrl(urlString);
  return provider ? provider.id : 'unknown';
}

module.exports = {
  getConfig,
  parseAllowedUrl,
  detectPlatform,
  allHosts,
};
