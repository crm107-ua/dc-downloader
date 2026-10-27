require('dotenv').config();

const { Client, Events, GatewayIntentBits, ActivityType } = require('discord.js');
const { getConfig, isGuildAllowed, isGuildAllowlistEnabled } = require('./config');
const { registerCommands, registerCommandsForGuild } = require('./register-commands');
const { snapshot: queueSnapshot } = require('./services/jobQueue');
const {
  isBotUnavailable,
  getOfflineMessage,
  markShuttingDown,
} = require('./utils/botAvailability');
const videoCommand = require('./commands/video');
const helpCommand = require('./commands/help');

const commands = {
  video: videoCommand,
  help: helpCommand,
};

const DENIED_MSG =
  'Este bot solo puede usarse en servidores autorizados. Este servidor no está en la lista permitida.';

async function replyUnavailable(interaction) {
  const content = getOfflineMessage();
  const payload = { content, ephemeral: true };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, embeds: [], components: [] }).catch(() => {});
  } else {
    await interaction.reply(payload).catch(() => {});
  }
}

async function leaveUnauthorizedGuild(guild, reason) {
  console.warn(`[guard] leaving guild ${guild.id} (${guild.name || 'unknown'}): ${reason}`);
  try {
    await guild.leave();
  } catch (err) {
    console.error(`[guard] failed to leave guild ${guild.id}:`, err.message || err);
  }
}

async function main() {
  const config = getConfig();
  if (!config.token || !config.clientId) {
    console.error('Faltan DISCORD_BOT_TOKEN o DISCORD_CLIENT_ID en .env');
    process.exit(1);
  }

  const restricted = isGuildAllowlistEnabled(config);
  if (restricted) {
    console.log(`Servidores permitidos: ${config.allowedGuildIds.join(', ')}`);
  } else {
    console.log('Servidores permitidos: todos (DISCORD_ALLOWED_GUILD_IDS vacío)');
  }

  if (config.botOffline) {
    console.warn(`[availability] BOT_OFFLINE activo → "${getOfflineMessage()}"`);
  }

  try {
    const { FFMPEG_BIN, FFPROBE_BIN, YT_DLP_BIN } = require('./utils/bins');
    console.log(`[bins] ffmpeg=${FFMPEG_BIN}`);
    console.log(`[bins] ffprobe=${FFPROBE_BIN}`);
    console.log(`[bins] yt-dlp=${YT_DLP_BIN}`);
  } catch (err) {
    console.warn(`[bins] no se pudieron resolver binarios: ${err.message || err}`);
  }

  await registerCommands();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  let exitStarted = false;
  async function gracefulExit(signal) {
    if (exitStarted) return;
    exitStarted = true;
    markShuttingDown(signal);

    try {
      client.user?.setPresence({
        status: 'dnd',
        activities: [{ name: 'Servidor apagado', type: ActivityType.Watching }],
      });
    } catch {
      // ignore
    }

    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const q = queueSnapshot();
      if (!q.active && q.waiting === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    try {
      client.destroy();
    } catch {
      // ignore
    }
    process.exit(0);
  }

  process.once('SIGTERM', () => {
    gracefulExit('SIGTERM').catch(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    gracefulExit('SIGINT').catch(() => process.exit(0));
  });

  client.once(Events.ClientReady, async (c) => {
    console.log(`Listo como ${c.user.tag}`);

    if (isBotUnavailable()) {
      try {
        await c.user.setPresence({
          status: 'dnd',
          activities: [{ name: 'Servidor apagado', type: ActivityType.Watching }],
        });
      } catch {
        // ignore
      }
    }

    if (!restricted) return;

    for (const [, guild] of c.guilds.cache) {
      if (!isGuildAllowed(guild.id, config)) {
        await leaveUnauthorizedGuild(guild, 'not in DISCORD_ALLOWED_GUILD_IDS');
      }
    }
  });

  client.on(Events.GuildCreate, async (guild) => {
    if (restricted && !isGuildAllowed(guild.id, config)) {
      await leaveUnauthorizedGuild(guild, 'invite blocked — not allowlisted');
      return;
    }

    console.log(`[guard] joined guild ${guild.id} (${guild.name})`);
    try {
      await registerCommandsForGuild(guild.id);
    } catch (err) {
      console.warn(
        `[guard] failed to register commands for guild ${guild.id}:`,
        err.message || err
      );
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (isBotUnavailable()) {
      await replyUnavailable(interaction);
      return;
    }

    if (!interaction.guildId || !isGuildAllowed(interaction.guildId, config)) {
      const payload = { content: DENIED_MSG, ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: DENIED_MSG, embeds: [] }).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
      return;
    }

    const command = commands[interaction.commandName];
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`Error en /${interaction.commandName}:`, err);
      const payload = {
        content: 'Error interno al procesar el comando.',
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
      }
    }
  });

  await client.login(config.token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
