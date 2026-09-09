const { EmbedBuilder } = require('discord.js');

const BAR_WIDTH = 16;
const FILLED = '█';
const EMPTY = '░';

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function renderBar(percent) {
  const p = clamp(Math.round(percent), 0, 100);
  const filled = Math.round((p / 100) * BAR_WIDTH);
  const bar = FILLED.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled);
  return `\`${bar}\` **${p}%**`;
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

const STAGE_LABELS = {
  metadata: 'Analizando enlace',
  download: 'Descargando',
  compress: 'Comprimiendo (calidad alta)',
  upload: 'Enviando a Discord',
  done: 'Listo',
};

/**
 * Throttled Discord progress UI with heartbeat so the bar never looks frozen.
 */
function createProgressReporter(interaction, { providerLabel }) {
  let lastSentAt = 0;
  let lastPercent = -1;
  let lastStage = '';
  let currentPercent = 0;
  let currentStage = 'metadata';
  let pending = null;
  let closed = false;
  let chain = Promise.resolve();
  const startedAt = Date.now();
  const minIntervalMs = 1800;
  let heartbeat = null;

  function buildPayload(percent, stage) {
    const label = STAGE_LABELS[stage] || stage;
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Procesando video')
      .setDescription(
        [
          renderBar(percent),
          '',
          `**${label}**`,
          providerLabel ? `Proveedor · ${providerLabel}` : null,
          `Tiempo · ${formatElapsed(Date.now() - startedAt)}`,
        ]
          .filter(Boolean)
          .join('\n')
      );
    return { content: null, embeds: [embed] };
  }

  async function flush(percent, stage, force = false) {
    if (closed) return;
    const now = Date.now();
    const stageChanged = stage !== lastStage;
    const jumped = Math.abs(percent - lastPercent) >= 1;
    if (!force && !stageChanged && !jumped && now - lastSentAt < minIntervalMs) {
      pending = { percent, stage };
      return;
    }

    lastSentAt = now;
    lastPercent = percent;
    lastStage = stage;
    currentPercent = percent;
    currentStage = stage;
    pending = null;

    chain = chain
      .then(async () => {
        if (closed) return;
        await interaction.editReply(buildPayload(percent, stage));
      })
      .catch(() => {});
    await chain;
  }

  heartbeat = setInterval(() => {
    if (closed) return;
    // Force a UI refresh so Discord never looks stuck during long encodes
    flush(currentPercent, currentStage, true).catch(() => {});
  }, 4000);

  return {
    async update(percent, stage) {
      const p = clamp(percent, 0, 100);
      currentPercent = p;
      currentStage = stage;
      await flush(p, stage, false);
    },
    async force(percent, stage) {
      currentPercent = clamp(percent, 0, 100);
      currentStage = stage;
      await flush(currentPercent, stage, true);
    },
    async flushPending() {
      if (pending) {
        await flush(pending.percent, pending.stage, true);
      }
    },
    close() {
      closed = true;
      pending = null;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    },
  };
}

function mapRange(ratio, start, end) {
  const r = clamp(ratio, 0, 100) / 100;
  return start + (end - start) * r;
}

module.exports = {
  renderBar,
  createProgressReporter,
  mapRange,
  STAGE_LABELS,
};
