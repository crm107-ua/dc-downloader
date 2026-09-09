const { EmbedBuilder } = require('discord.js');

const BAR_WIDTH = 16;
const FILLED = '█';
const EMPTY = '░';

const QUALITY_LABELS = {
  rapida: 'Rápida',
  auto: 'Auto',
  alta: 'Alta',
};

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

function compressLabel(qualityMode) {
  if (qualityMode === 'rapida') return 'Comprimiendo (rápida)';
  if (qualityMode === 'auto') return 'Comprimiendo (auto)';
  return 'Comprimiendo (calidad alta)';
}

function stageLabel(stage, qualityMode) {
  if (stage === 'queued') return 'En cola';
  if (stage === 'compress') return compressLabel(qualityMode);
  const map = {
    metadata: 'Analizando enlace',
    download: 'Descargando',
    upload: 'Enviando a Discord',
    done: 'Listo',
  };
  return map[stage] || stage;
}

/**
 * Throttled Discord progress UI with heartbeat so the bar never looks frozen.
 */
function createProgressReporter(interaction, { providerLabel, qualityMode } = {}) {
  let lastSentAt = 0;
  let lastPercent = -1;
  let lastStage = '';
  let currentPercent = 0;
  let currentStage = 'metadata';
  let queueInfo = null;
  let pending = null;
  let closed = false;
  let chain = Promise.resolve();
  const startedAt = Date.now();
  const minIntervalMs = 1800;
  let heartbeat = null;

  function buildPayload(percent, stage) {
    const lines = [renderBar(percent), '', `**${stageLabel(stage, qualityMode)}**`];

    if (stage === 'queued' && queueInfo && queueInfo.position > 0) {
      lines.push(
        `Posición · **${queueInfo.position}** en espera`,
        'Se procesará cuando termine el video anterior'
      );
    }

    if (providerLabel) lines.push(`Proveedor · ${providerLabel}`);
    if (qualityMode) {
      lines.push(`Calidad · ${QUALITY_LABELS[qualityMode] || qualityMode}`);
    }
    lines.push(`Tiempo · ${formatElapsed(Date.now() - startedAt)}`);

    const embed = new EmbedBuilder()
      .setColor(stage === 'queued' ? 0xfaa61a : 0x5865f2)
      .setTitle(stage === 'queued' ? 'En cola' : 'Procesando video')
      .setDescription(lines.join('\n'));
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
    async setQueued(info) {
      queueInfo = info;
      currentStage = 'queued';
      currentPercent = 0;
      await flush(0, 'queued', true);
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
  QUALITY_LABELS,
};
