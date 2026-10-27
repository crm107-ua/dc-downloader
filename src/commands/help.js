const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getConfig } = require('../config');
const { supportedLabels, listProviders } = require('../providers');

const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Cómo usar el bot (explicación sencilla)');

async function execute(interaction) {
  const config = getConfig();
  const maxMin = Math.floor(config.maxDurationSeconds / 60);
  const longMin = Math.floor(config.r2LongVideoSeconds / 60);
  const maxMb = config.maxFileSizeMb;
  const r2Gb = config.r2MaxStorageGb;
  const tempH = config.tempMaxAgeHours;
  const providers = listProviders()
    .map((p) => p.label)
    .join(', ');

  const embed = new EmbedBuilder()
    .setTitle('Cómo usar este bot')
    .setDescription(
      'Pega el enlace de un vídeo o foto y el bot lo descarga y lo deja en este canal para que todo el mundo lo vea sin salir de Discord.'
    )
    .addFields(
      {
        name: 'Qué tienes que hacer',
        value: [
          '1. Escribe `/video`',
          '2. En **url** pega el enlace (YouTube, TikTok, Instagram, Spotify track, etc.)',
          '3. Opcional: **calidad** (`auto` suele ir bien) y **descripcion** (texto del post)',
          '4. Espera: verás una barra de progreso y, al terminar, el vídeo en el chat',
          '',
          'Si el post de Instagram es un carrusel (varias fotos/vídeos), el bot te preguntará cuál quieres.',
        ].join('\n'),
      },
      {
        name: 'Sitios que acepta',
        value: providers || supportedLabels(),
      },
      {
        name: 'Spotify (tracks)',
        value: [
          'Pega un enlace de **track** (no álbum ni playlist).',
          'El bot busca el **videoclip** (Spotify → YouTube) y lo comprime a ≤10 MB.',
          'Si no hay videoclip: *No hay videoclip disponible para este track.*',
        ].join('\n'),
      },
      {
        name: 'Calidad (opcional)',
        value: [
          `**auto** — equilibrado (por defecto)`,
          `**alta** — se ve mejor, tarda más (vídeos cortos)`,
          `**rapida** — más rápido, un poco peor (vídeos cortos)`,
          '',
          `Si el vídeo dura **más de ${longMin} minutos**, da igual la calidad que elijas: se guarda en la máxima calidad posible y se reproduce con un reproductor en el chat (no se aprieta a ${maxMb} MB).`,
        ].join('\n'),
      },
      {
        name: 'Descripción (opcional)',
        value:
          'Activa **descripcion** para enviar también el texto del post (p. ej. el tuit) encima del vídeo, junto al nombre de quien usó `/video`.',
      },
      {
        name: 'Cuánto puede durar y cómo llega',
        value: [
          `Máximo **${maxMin} minutos** (cualquier sitio).`,
          '',
          `**${longMin} min o menos** → el bot lo comprime y lo **adjunta** al mensaje (límite Discord ≈ **${maxMb} MB**). Ese archivo no queda guardado en la nube del bot.`,
          '',
          config.r2Enabled
            ? `**Más de ${longMin} min** → se sube a un alojamiento (R2) en **alta calidad** y Discord muestra el vídeo debajo. Vale para **todos** los sitios, no solo YouTube.`
            : `**Más de ${longMin} min** → hace falta tener el alojamiento largo activado en el servidor.`,
        ].join('\n'),
      },
      {
        name: 'Cola (si hay mucha gente)',
        value:
          'Solo se procesa **un** vídeo a la vez. Si varias personas piden a la vez, entras en cola y verás tu posición hasta que te toque.',
      },
      {
        name: 'Borrado / espacio (sin tecnicismos)',
        value: [
          `**Vídeos cortos (adjunto ≤${longMin} min):** al terminar, el bot borra su copia temporal del servidor. Si algo se queda colgado, se limpia solo a las **${tempH} horas**. En el chat el mensaje con el vídeo **no** se borra solo.`,
          '',
          config.r2Enabled
            ? `**Vídeos largos (R2, >${longMin} min):** no caducan por días. Cuando el almacén se acerca a **~${r2Gb} GB**, se borran primero los **más antiguos** para hacer sitio a los nuevos (como una estantería que se limpia desde atrás).`
            : null,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      {
        name: 'Ejemplo',
        value: '`/video url:https://www.youtube.com/watch?v=...`',
      }
    )
    .setFooter({
      text: 'by Wanikoko',
    });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { data, execute };
