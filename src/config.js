const {
  resolveProviderByUrl,
  resolveProviderByHost,
  supportedLabelsForError,
  allHosts,
} = require('./providers');

function parseIdList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function getConfig() {
  // Global max duration (all providers). Attachment path only used for clips ≤ R2_LONG_VIDEO_SECONDS.
  const maxDuration = Number(process.env.MAX_DURATION_SECONDS || 1800);
  const maxFileSizeMb = Number(process.env.MAX_FILE_SIZE_MB || 10);
  const tempDir = process.env.TEMP_DIR || './temp';
  const tempMaxAgeHours = Number(process.env.TEMP_MAX_AGE_HOURS || 24);
  const r2LongVideoSeconds = Number(process.env.R2_LONG_VIDEO_SECONDS || 300);
  // Soft cap under Cloudflare free 10 GB (FIFO eviction when exceeded).
  const r2MaxStorageGb = Number(process.env.R2_MAX_STORAGE_GB || 9);

  // Preferred: DISCORD_ALLOWED_GUILD_IDS=id1,id2
  // Backward-compatible fallbacks for older .env names
  const allowedGuildIds = [
    ...parseIdList(process.env.DISCORD_ALLOWED_GUILD_IDS),
    ...parseIdList(process.env.DISCORD_GUILD_ID),
    ...parseIdList(process.env.DISCORD_CHANNEL_ID),
    ...parseIdList(process.env.DISCORD_CHANNEL_ID_2),
    ...parseIdList(process.env.DICORD_CHANNEL_ID),
    ...parseIdList(process.env.DICORD_CHANNEL_ID_2),
  ];
  const uniqueGuildIds = [...new Set(allowedGuildIds)];

  const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID || '';
  const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
  const r2Bucket = process.env.R2_BUCKET || '';
  const r2Endpoint = process.env.R2_ENDPOINT || '';
  const r2PublicBaseUrl = process.env.R2_PUBLIC_BASE_URL || '';
  const r2EnabledFlag = String(process.env.R2_ENABLED || '').trim();
  const r2Enabled =
    (r2EnabledFlag === '1' || /^true$/i.test(r2EnabledFlag)) &&
    Boolean(r2AccessKeyId && r2SecretAccessKey && r2Bucket && r2Endpoint && r2PublicBaseUrl);

  const maxDurationSeconds = Number.isFinite(maxDuration) && maxDuration > 0 ? maxDuration : 1800;
  const longThreshold =
    Number.isFinite(r2LongVideoSeconds) && r2LongVideoSeconds > 0 ? r2LongVideoSeconds : 300;
  const maxStorageGb =
    Number.isFinite(r2MaxStorageGb) && r2MaxStorageGb > 0 ? r2MaxStorageGb : 9;

  return {
    token: process.env.DISCORD_BOT_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    allowedGuildIds: uniqueGuildIds,
    cookiesFile: process.env.COOKIES_FILE || '',
    cookiesFromBrowser: process.env.COOKIES_FROM_BROWSER || '',
    maxDurationSeconds,
    maxFileSizeMb: Number.isFinite(maxFileSizeMb) ? maxFileSizeMb : 10,
    maxFileSizeBytes: Math.floor((Number.isFinite(maxFileSizeMb) ? maxFileSizeMb : 10) * 1024 * 1024),
    tempDir,
    tempMaxAgeHours: Number.isFinite(tempMaxAgeHours) && tempMaxAgeHours > 0 ? tempMaxAgeHours : 24,
    // Long videos (> threshold) go to Cloudflare R2 at high quality (no 10 MB compress).
    r2Enabled,
    r2AccountId: process.env.R2_ACCOUNT_ID || '',
    r2AccessKeyId,
    r2SecretAccessKey,
    r2Bucket,
    r2Endpoint,
    r2PublicBaseUrl: String(r2PublicBaseUrl).replace(/\/+$/, ''),
    r2LongVideoSeconds: longThreshold,
    // Same hard cap for attachment and R2 paths (default 30 min).
    maxDurationR2Seconds: maxDurationSeconds,
    r2MaxStorageGb: maxStorageGb,
    r2MaxStorageBytes: Math.floor(maxStorageGb * 1024 * 1024 * 1024),
  };
}

function isGuildAllowed(guildId, config = getConfig()) {
  if (!guildId) return false;
  const allowed = config.allowedGuildIds || [];
  // Empty allowlist = unrestricted (any guild the bot is in)
  if (!allowed.length) return true;
  return allowed.includes(String(guildId));
}

function isGuildAllowlistEnabled(config = getConfig()) {
  return (config.allowedGuildIds || []).length > 0;
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
  isGuildAllowed,
  isGuildAllowlistEnabled,
  parseAllowedUrl,
  detectPlatform,
  allHosts,
};
