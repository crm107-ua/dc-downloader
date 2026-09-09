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

const STAGE_LABELS = {
  metadata: 'Analizando enlace',
  download: 'Descargando',
  compress: 'Comprimiendo',
  upload: 'Enviando a Discord',
  done: 'Listo',
};

/**
 * Throttled Discord progress UI (replaces "is thinking…").
 */
function createProgressReporter(interaction, { providerLabel }) {
  let lastSentAt = 0;
  let lastPercent = -1;
  let lastStage = '';
  let pending = null;
  let closed = false;
  let chain = Promise.resolve();
  const minIntervalMs = 1500;

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
    const jumped = Math.abs(percent - lastPercent) >= 3;
    if (!force && !stageChanged && !jumped && now - lastSentAt < minIntervalMs) {
      pending = { percent, stage };
      return;
    }

    lastSentAt = now;
    lastPercent = percent;
    lastStage = stage;
    pending = null;

    // Serialize Discord edits to avoid rate-limit pileups that freeze the UI
    chain = chain
      .then(async () => {
        if (closed) return;
        await interaction.editReply(buildPayload(percent, stage));
      })
      .catch(() => {});
    await chain;
  }

  return {
    async update(percent, stage) {
      const p = clamp(percent, 0, 100);
      await flush(p, stage, false);
    },
    async force(percent, stage) {
      await flush(clamp(percent, 0, 100), stage, true);
    },
    async flushPending() {
      if (pending) {
        await flush(pending.percent, pending.stage, true);
      }
    },
    close() {
      closed = true;
      pending = null;
    },
  };
}

/** Map a 0–100 stage ratio into a global percent window */
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
