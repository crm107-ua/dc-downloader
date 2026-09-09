require('dotenv').config();

const { REST, Routes } = require('discord.js');
const { getConfig } = require('./config');
const videoCommand = require('./commands/video');
const helpCommand = require('./commands/help');

async function registerCommands() {
  const config = getConfig();
  if (!config.token || !config.clientId) {
    throw new Error('Faltan DISCORD_BOT_TOKEN o DISCORD_CLIENT_ID en .env');
  }

  const body = [videoCommand.data.toJSON(), helpCommand.data.toJSON()];
  const rest = new REST({ version: '10' }).setToken(config.token);

  // Replace ALL global application commands (removes legacy /download)
  await rest.put(Routes.applicationCommands(config.clientId), { body });
  console.log('Global commands refreshed: /video, /help (legacy /download cleared)');

  const guildIds = new Set();
  if (config.guildId) guildIds.add(config.guildId);

  // Sync guild commands for every server the bot is in (instant client update)
  try {
    const guilds = await rest.get(Routes.userGuilds());
    for (const guild of guilds) {
      if (guild && guild.id) guildIds.add(guild.id);
    }
  } catch (err) {
    console.warn('No se pudieron listar guilds para sync instantaneo:', err.message || err);
  }

  for (const guildId of guildIds) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body });
    console.log(`Guild ${guildId}: /video, /help`);
  }

  if (!guildIds.size) {
    console.log(
      'Sin guilds sincronizados. Los comandos globales pueden tardar minutos en Discord; añade DISCORD_GUILD_ID o reinicia tras invitar el bot.'
    );
  }
}

if (require.main === module) {
  registerCommands().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { registerCommands };
