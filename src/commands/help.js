const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getConfig } = require('../config');
const { supportedLabels, listProviders } = require('../providers');

const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Ayuda de uso del bot de descarga de videos');

async function execute(interaction) {
  const config = getConfig();
  const maxMin = Math.floor(config.maxDurationSeconds / 60);
  const maxMb = config.maxFileSizeMb;
  const providers = listProviders()
    .map((p) => p.label)
    .join(' · ');

  const embed = new EmbedBuilder()
    .setTitle('Ayuda · Video Downloader')
    .setDescription(
      `Descarga videos cortos de **${supportedLabels()}** y los envía en este mismo canal.`
    )
    .addFields(
      {
        name: 'Comandos',
        value: [
          '`/video url:<enlace>` — descarga y envía el video',
          '`/help` — muestra esta ayuda',
        ].join('\n'),
      },
      {
        name: 'Plataformas soportadas',
        value: providers || supportedLabels(),
      },
      {
        name: 'Límites',
        value: [
          `Duración máxima **antes** de descargar: **${maxMin} min** (\`MAX_DURATION_SECONDS=${config.maxDurationSeconds}\`)`,
          `Tamaño máximo del archivo enviado: **${maxMb} MB** (\`MAX_FILE_SIZE_MB=${maxMb}\`)`,
        ].join('\n'),
      },
      {
        name: 'Ejemplo',
        value: '`/video url:https://www.youtube.com/watch?v=...`',
      }
    )
    .setFooter({ text: 'Si Reddit/X fallan por login, configura COOKIES_FILE o COOKIES_FROM_BROWSER en .env' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { data, execute };
