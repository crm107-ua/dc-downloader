const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { parseAllowedUrl } = require('../config');
const { downloadAndPrepare } = require('../services/downloader');

const data = new SlashCommandBuilder()
  .setName('video')
  .setDescription('Descarga un video (X, Reddit, YouTube, TikTok) y lo envía aquí')
  .addStringOption((option) =>
    option
      .setName('url')
      .setDescription('Enlace del video')
      .setRequired(true)
  );

async function execute(interaction) {
  const rawUrl = interaction.options.getString('url', true);

  let url;
  try {
    url = parseAllowedUrl(rawUrl);
  } catch (err) {
    await interaction.reply({ content: err.message, ephemeral: true });
    return;
  }

  await interaction.deferReply();

  let result;
  try {
    result = await downloadAndPrepare(url);
  } catch (err) {
    let message = err && err.message ? err.message : 'Error desconocido al descargar.';
    if (/authentication is required|cookies/i.test(message)) {
      message =
        'Esta URL requiere cookies (típico en Reddit). Configura COOKIES_FILE o COOKIES_FROM_BROWSER en .env.\n' +
        message;
    }
    await interaction.editReply({
      content: `No se pudo descargar el video:\n\`\`\`${message.slice(0, 1500)}\`\`\``,
    });
    return;
  }

  try {
    const safeName = `${result.platform}-${Date.now()}.mp4`;
    const attachment = new AttachmentBuilder(result.filePath, { name: safeName });

    await interaction.editReply({
      content: null,
      files: [attachment],
    });
  } catch (err) {
    const message = err && err.message ? err.message : 'Error al enviar el archivo.';
    await interaction.editReply({
      content: `Descarga OK pero falló el envío:\n\`\`\`${message.slice(0, 1500)}\`\`\``,
    });
  } finally {
    if (result && typeof result.cleanup === 'function') {
      result.cleanup();
    }
  }
}

module.exports = { data, execute };
