const {
  SlashCommandBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} = require('discord.js');
const path = require('path');
const { parseAllowedUrl } = require('../config');
const { resolveProviderByUrl } = require('../providers');
const { downloadAndPrepare, listMediaChoices } = require('../services/downloader');
const { enqueue } = require('../services/jobQueue');
const { createProgressReporter } = require('../utils/progress');
const { normalizeQualityMode } = require('../services/compressor');
const { formatDownloadError } = require('../utils/downloadError');

const CAROUSEL_TIMEOUT_MS = 120000;

const data = new SlashCommandBuilder()
  .setName('video')
  .setDescription('Descarga un video (X, Reddit, YouTube, TikTok, Instagram, Facebook) y lo envía aquí')
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

/**
 * If the provider exposes a carousel, ask the invoking user which slide to download.
 * @returns {Promise<null | { playlistItem: number, mediaKind: 'video'|'photo' }>}
 */
async function promptCarouselChoice(interaction, choices) {
  if (!choices || !choices.isCarousel || !Array.isArray(choices.items) || choices.items.length <= 1) {
    return null;
  }

  const customId = `igcarousel:${interaction.id}`;
  const options = choices.items.slice(0, 25).map((item) => ({
    label: item.label.slice(0, 100),
    description: `${item.kind === 'video' ? 'Vídeo' : 'Foto'} · ${item.id}`.slice(0, 100),
    value: `${item.index}:${item.kind}`,
  }));

  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Elige un elemento del carrusel (1, 2, 3…)')
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(select);
  const listPreview = choices.items
    .slice(0, 15)
    .map((item) => `**${item.index}.** ${item.kind === 'video' ? 'Vídeo' : 'Foto'}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle('Carrusel de Instagram')
    .setDescription(
      [
        choices.title ? `**${choices.title}**` : null,
        `Hay **${choices.items.length}** elementos. Elige cuál quieres descargar:`,
        '',
        listPreview,
        choices.items.length > 15 ? `… y ${choices.items.length - 15} más` : null,
        '',
        `_Tienes ${Math.round(CAROUSEL_TIMEOUT_MS / 1000)}s para elegir._`,
      ]
        .filter(Boolean)
        .join('\n')
    );

  const message = await interaction.editReply({
    embeds: [embed],
    components: [row],
  });

  let selection;
  try {
    selection = await message.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id && i.customId === customId,
      time: CAROUSEL_TIMEOUT_MS,
    });
  } catch {
    await interaction.editReply({
      content: 'Tiempo agotado: no se eligió ningún elemento del carrusel.',
      embeds: [],
      components: [],
    });
    return false;
  }

  await selection.deferUpdate();
  const [indexRaw, kindRaw] = String(selection.values[0] || '').split(':');
  const playlistItem = Number(indexRaw);
  const mediaKind = kindRaw === 'photo' ? 'photo' : 'video';
  if (!Number.isFinite(playlistItem) || playlistItem < 1) {
    await interaction.editReply({
      content: 'Selección inválida del carrusel.',
      embeds: [],
      components: [],
    });
    return false;
  }

  await interaction.editReply({
    content: `Elemento **${playlistItem}** (${mediaKind === 'photo' ? 'foto' : 'vídeo'}) seleccionado. Preparando descarga…`,
    embeds: [],
    components: [],
  });

  return { playlistItem, mediaKind };
}

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

  let carouselPick = null;
  if (provider && typeof provider.listMediaChoices === 'function') {
    try {
      await interaction.editReply({ content: 'Analizando enlace de Instagram…' });
      const choices = await listMediaChoices(url);
      if (choices && choices.isCarousel) {
        const pick = await promptCarouselChoice(interaction, choices);
        if (pick === false) return;
        carouselPick = pick;
      }
    } catch (err) {
      const message = err && err.message ? err.message : 'No se pudo analizar el carrusel.';
      await interaction.editReply({
        content: `No se pudo preparar el carrusel:\n\`\`\`${message.slice(0, 1500)}\`\`\``,
        embeds: [],
        components: [],
      });
      return;
    }
  }

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
          playlistItem: carouselPick ? carouselPick.playlistItem : undefined,
          mediaKind: carouselPick ? carouselPick.mediaKind : undefined,
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
    await progress.close();
    const message = formatDownloadError(err && err.message ? err.message : err);
    await interaction.editReply({
      content: `No se pudo descargar el media:\n\`\`\`${message}\`\`\``,
      embeds: [],
      components: [],
    });
    return;
  }

  try {
    await progress.force(98, 'upload');
    const isImage = result.mediaType === 'image';
    const ext = isImage
      ? path.extname(result.filePath) || '.jpg'
      : '.mp4';
    const safeName = `${result.platform}-${Date.now()}${ext}`;
    const attachment = new AttachmentBuilder(result.filePath, { name: safeName });

    // Delete progress reply, then send a standalone channel message (not followUp).
    // followUp replies to the interaction message — if that was deleted, Discord
    // shows "No se ha podido cargar el mensaje" above the video.
    await progress.close();
    await interaction.deleteReply().catch(() => {});

    const requesterName =
      (interaction.member && interaction.member.displayName) ||
      interaction.user.globalName ||
      interaction.user.username;
    const requesterEmbed = new EmbedBuilder()
      .setColor(0x2b2d31)
      .setAuthor({
        name: requesterName,
        iconURL: interaction.user.displayAvatarURL({ size: 128 }),
      });

    await interaction.channel.send({
      embeds: [requesterEmbed],
      files: [attachment],
    });
  } catch (err) {
    await progress.close();
    const message = err && err.message ? err.message : 'Error al enviar el archivo.';
    const errorText = `Descarga OK pero falló el envío:\n\`\`\`${message.slice(0, 1500)}\`\`\``;
    try {
      await interaction.editReply({
        content: errorText,
        embeds: [],
        files: [],
        components: [],
      });
    } catch {
      await interaction.channel.send({ content: errorText }).catch(() => {});
    }
  } finally {
    if (result && typeof result.cleanup === 'function') {
      result.cleanup();
    }
  }
}

module.exports = { data, execute };
