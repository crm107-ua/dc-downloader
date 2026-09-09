const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { parseAllowedUrl } = require('../config');
const { resolveProviderByUrl } = require('../providers');
const { downloadAndPrepare } = require('../services/downloader');
const { enqueue } = require('../services/jobQueue');
const { createProgressReporter } = require('../utils/progress');
const { normalizeQualityMode } = require('../services/compressor');

const data = new SlashCommandBuilder()
  .setName('video')
  .setDescription('Descarga un video (X, Reddit, YouTube, TikTok) y lo envía aquí')
  .addStringOption((option) =>
    option
      .setName('url')
      .setDescription('Enlace del video')
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('calidad')
      .setDescription('Compresión: auto (defecto) · alta · rapida')
      .setRequired(false)
      .addChoices(
        { name: 'Auto (recomendado)', value: 'auto' },
        { name: 'Alta (más lento, mejor imagen)', value: 'alta' },
        { name: 'Rápida (menos calidad)', value: 'rapida' }
      )
  );

async function execute(interaction) {
  const rawUrl = interaction.options.getString('url', true);
  const calidadOpt = interaction.options.getString('calidad');

  let url;
  try {
    url = parseAllowedUrl(rawUrl);
  } catch (err) {
    await interaction.reply({ content: err.message, ephemeral: true });
    return;
  }

  const provider = resolveProviderByUrl(url);
  const qualityMode = normalizeQualityMode(calidadOpt || 'auto');

  await interaction.deferReply();

  const progress = createProgressReporter(interaction, {
    providerLabel: provider ? provider.label : '',
    qualityMode,
  });

  let result;
  try {
    result = await enqueue(
      async () =>
        downloadAndPrepare(url, {
          qualityMode,
          onProgress: (percent, stage) => progress.update(percent, stage),
        }),
      {
        onQueued: (info) => {
          // Only show queue UI if someone is ahead
          if (info.position > 0) {
            progress.setQueued(info).catch(() => {});
          }
        },
        onStart: () => {
          progress.force(1, 'metadata').catch(() => {});
        },
      }
    );
  } catch (err) {
    progress.close();
    let message = err && err.message ? err.message : 'Error desconocido al descargar.';
    if (/authentication is required|cookies/i.test(message)) {
      message =
        'Esta URL requiere cookies (típico en Reddit). Configura COOKIES_FILE o COOKIES_FROM_BROWSER en .env.\n' +
        message;
    }
    await interaction.editReply({
      content: `No se pudo descargar el video:\n\`\`\`${message.slice(0, 1500)}\`\`\``,
      embeds: [],
    });
    return;
  }

  try {
    await progress.force(98, 'upload');
    const safeName = `${result.platform}-${Date.now()}.mp4`;
    const attachment = new AttachmentBuilder(result.filePath, { name: safeName });

    progress.close();
    await interaction.editReply({
      content: null,
      embeds: [],
      files: [attachment],
    });
  } catch (err) {
    progress.close();
    const message = err && err.message ? err.message : 'Error al enviar el archivo.';
    await interaction.editReply({
      content: `Descarga OK pero falló el envío:\n\`\`\`${message.slice(0, 1500)}\`\`\``,
      embeds: [],
    });
  } finally {
    if (result && typeof result.cleanup === 'function') {
      result.cleanup();
    }
  }
}

module.exports = { data, execute };
