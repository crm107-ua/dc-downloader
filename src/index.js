require('dotenv').config();

const { Client, Events, GatewayIntentBits } = require('discord.js');
const { getConfig, isGuildAllowed } = require('./config');
const { registerCommands } = require('./register-commands');
const videoCommand = require('./commands/video');
const helpCommand = require('./commands/help');

const commands = {
  video: videoCommand,
  help: helpCommand,
};

const DENIED_MSG =
  'Este bot solo puede usarse en servidores autorizados. Este servidor no está en la lista permitida.';

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
  if (!config.allowedGuildIds.length) {
    console.error('Falta DISCORD_ALLOWED_GUILD_IDS en .env');
    process.exit(1);
  }

  console.log(`Servidores permitidos: ${config.allowedGuildIds.join(', ')}`);
  await registerCommands();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, async (c) => {
    console.log(`Listo como ${c.user.tag}`);

    // Leave any unauthorized guilds already joined
    for (const [, guild] of c.guilds.cache) {
      if (!isGuildAllowed(guild.id, config)) {
        await leaveUnauthorizedGuild(guild, 'not in DISCORD_ALLOWED_GUILD_IDS');
      }
    }
  });

  // If invited elsewhere, leave immediately
  client.on(Events.GuildCreate, async (guild) => {
    if (!isGuildAllowed(guild.id, config)) {
      await leaveUnauthorizedGuild(guild, 'invite blocked — not allowlisted');
    } else {
      console.log(`[guard] joined allowlisted guild ${guild.id} (${guild.name})`);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

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
