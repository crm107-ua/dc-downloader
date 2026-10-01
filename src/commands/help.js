const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getConfig } = require('../config');
const { supportedLabels, listProviders } = require('../providers');

const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Ayuda de uso del bot de descarga de videos');

async function execute(interaction) {
  const config = getConfig();
  const maxMin = Math.floor(config.maxDurationSeconds / 60);
  const longMin = Math.floor(config.r2LongVideoSeconds / 60);
  const maxMb = config.maxFileSizeMb;
  const r2Gb = config.r2MaxStorageGb;
  const providers = listProviders()
    .map((p) => p.label)
    .join(' · ');

  const embed = new EmbedBuilder()
    .setTitle('Ayuda · Video Downloader')
    .setDescription(
      `Descarga videos de **${supportedLabels()}** y los envía en este mismo canal.`
    )
    .addFields(
      {
        name: 'Comandos',
        value: [
          '`/video url:<enlace> [calidad]` — descarga y envía el video',
          'En carruseles de Instagram te pide qué elemento (1, 2, 3…) quieres',
          '`/help` — muestra esta ayuda',
        ].join('\n'),
      },
      {
        name: 'Cola',
        value:
          'Puedes usar `/video` en varios canales a la vez. Solo se procesa **uno** cada vez; el resto espera en cola con su posición visible.',
      },
      {
        name: 'Calidad',
        value: [
          '`auto` — equilibrado (**por defecto** si no eliges nada)',
          '`alta` — máxima calidad, más lento (clips cortos)',
          '`rapida` — menos calidad, más rápido (clips cortos)',
          `Vale para ${supportedLabels()}.`,
          `En vídeos >${longMin} min no se comprime a ${maxMb} MB: se sube en alta calidad.`,
        ].join('\n'),
      },
      {
        name: 'Plataformas soportadas',
        value: providers || supportedLabels(),
      },
      {
        name: 'Límites y entrega',
        value: [
          `Duración máxima (todos los proveedores): **${maxMin} min**`,
          `≤ **${longMin} min** → adjunto Discord comprimido (máx. **${maxMb} MB**)`,
          config.r2Enabled
            ? `> **${longMin} min** → Cloudflare R2 en alta calidad + player inline en Discord`
            : `> **${longMin} min** → requiere R2 configurado en el servidor`,
        ].join('\n'),
      },
      {
        name: 'Limpieza',
        value: [
          `Temp del VPS: se borra la carpeta de cada job al terminar; residuos >**${config.tempMaxAgeHours} h** se barren`,
          config.r2Enabled
            ? `R2: no se borra por tiempo — FIFO al acercarse a **${r2Gb} GB** (tope gratis ~10 GB)`
            : null,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      {
        name: 'Ejemplo',
        value: '`/video url:https://www.youtube.com/watch?v=... calidad:alta`',
      }
    )
    .setFooter({
      text: 'TikTok/Instagram sin cookies cuando hace falta · YouTube edad puede requerir COOKIES_FILE · by Wanikoko',
    });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { data, execute };
