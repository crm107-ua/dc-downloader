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
const {
  isInstagramMediaPost,
  mayBeInstagramCarousel,
} = require('../providers/instagram');

const CAROUSEL_TIMEOUT_MS = 120000;

const data = new SlashCommandBuilder()
  .setName('video')
  .setDescription(
    'Descarga un video (X, Reddit, YouTube, TikTok, Instagram, Facebook, Spotify) y lo envía aquí'
  )
  .addStringOption((option) =>
    option
      .setName('url')
      .setDescription('Enlace del video o track de Spotify')
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
  )
  .addBooleanOption((option) =>
    option
      .setName('descripcion')
      .setDescription('Incluye el texto del post (p. ej. el tuit) encima del vídeo')
      .setRequired(false)
  )
  .addBooleanOption((option) =>
    option
      .setName('spoiler')
      .setDescription('Envía el media como spoiler de Discord (contenido delicado)')
      .setRequired(false)
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
  const includeDescription = Boolean(interaction.options.getBoolean('descripcion'));
  const asSpoiler = Boolean(interaction.options.getBoolean('spoiler'));

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
  if (provider && provider.id === 'instagram' && !isInstagramMediaPost(url)) {
    await interaction.editReply({
      content:
        'Ese enlace de Instagram no es un reel, post o carrusel. Pega el enlace del vídeo o la foto concreta.',
      embeds: [],
      components: [],
    });
    return;
  }

  if (
    provider &&
    provider.id === 'instagram' &&
    typeof provider.listMediaChoices === 'function' &&
    mayBeInstagramCarousel(url)
  ) {
    try {
      await interaction.editReply({ content: 'Analizando carrusel de Instagram…' });
      const choices = await listMediaChoices(url);
      if (choices && choices.isCarousel) {
        const pick = await promptCarouselChoice(interaction, choices);
        if (pick === false) return;
        carouselPick = pick;
      }
    } catch (err) {
      // Never abort /video here: Restricted / rate-limit / login walls are recovered
      // later via provider.fetchFallbackMedia in the download pipeline.
      console.warn(
        `[video] carousel probe failed, continuing as single media: ${err && err.message ? err.message : err}`
      );
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
          includeDescription,
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
    console.error(`[video] download failed: ${message}`);
    const content = `No se pudo descargar el media:\n${message}`;
    try {
      await interaction.editReply({ content, embeds: [], components: [] });
    } catch {
      await interaction.channel.send({ content }).catch(() => {});
    }
    return;
  }

  try {
    await progress.force(98, 'upload');

    // Delete progress reply, then send standalone channel messages (not followUp).
    await progress.close();
    await interaction.deleteReply().catch(() => {});

    const requesterName =
      (interaction.member && interaction.member.displayName) ||
      interaction.user.globalName ||
      interaction.user.username;
    // Compact card: avatar + "Name · 🔗" (+ optional post caption under it).
    const requesterEmbed = new EmbedBuilder()
      .setColor(0x2b2d31)
      .setAuthor({
        name: `${requesterName} · 🔗`,
        iconURL: interaction.user.displayAvatarURL({ size: 64 }),
        url,
      });

    if (includeDescription && result.caption) {
      // Plain text (no wrapping *italics*): Discord cuts italic at newlines / "*".
      const safe = String(result.caption)
        .replace(/\\/g, '\\\\')
        .replace(/`/g, "'");
      requesterEmbed.setDescription(safe.slice(0, 4096));
    }

    // Card first (username · 🔗 ± caption), then media.
    // Use channel.send (not interaction followUp) so delivery survives expired tokens.
    const channel = interaction.channel;
    if (!channel || typeof channel.send !== 'function') {
      throw new Error('No hay canal para enviar el media.');
    }

    await channel.send({ embeds: [requesterEmbed] });
    console.log(
      `[video] card sent platform=${result.platform} delivery=${result.delivery || 'attachment'} bytes=${result.sizeBytes || 0}`
    );

    if (result.delivery === 'r2' && result.publicUrl) {
      // Bare MP4 URL → Discord unfurls the inline player.
      // Spoiler-tag the URL when requested (attachment spoiler only works for files).
      const content = asSpoiler ? `||${result.publicUrl}||` : result.publicUrl;
      await channel.send({ content });
      console.log(`[video] r2 link sent ${result.publicUrl}`);
    } else {
      const isImage = result.mediaType === 'image';
      const ext = isImage
        ? path.extname(result.filePath) || '.jpg'
        : '.mp4';
      const safeName = `${result.platform}-${Date.now()}${ext}`;
      // discord.js ignores `{ spoiler: true }` in the ctor — must call setSpoiler()
      // so the file is named SPOILER_… (Discord's actual spoiler mark).
      const attachment = new AttachmentBuilder(result.filePath, { name: safeName });
      if (asSpoiler) attachment.setSpoiler(true);
      await channel.send({ files: [attachment] });
      console.log(`[video] attachment sent ${safeName} bytes=${result.sizeBytes || 0}`);
    }
  } catch (err) {
    await progress.close();
    const message = err && err.message ? err.message : 'Error al enviar el archivo.';
    console.error(`[video] send failed: ${message}`);
    const errorText = `Descarga OK pero falló el envío:\n\`\`\`${message.slice(0, 1500)}\`\`\``;
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: errorText });
      } else {
        await interaction.followUp({ content: errorText }).catch(async () => {
          await interaction.channel.send({ content: errorText });
        });
      }
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
