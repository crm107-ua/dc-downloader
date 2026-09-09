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
  if (!config.allowedGuildIds.length) {
    throw new Error(
      'Falta DISCORD_ALLOWED_GUILD_IDS en .env (IDs de servidores permitidos, separados por coma).'
    );
  }

  const body = [videoCommand.data.toJSON(), helpCommand.data.toJSON()];
  const rest = new REST({ version: '10' }).setToken(config.token);
  const allowed = new Set(config.allowedGuildIds.map(String));

  // Never register globally — avoids use outside allowlisted servers
  await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
  console.log('Global commands cleared');

  // Discover guilds the bot is currently in
  const presentGuildIds = new Set();
  try {
    const guilds = await rest.get(Routes.userGuilds());
    for (const guild of guilds) {
      if (guild && guild.id) presentGuildIds.add(String(guild.id));
    }
  } catch (err) {
    console.warn('No se pudieron listar guilds:', err.message || err);
  }

  // Register slash commands only on allowed guilds (skip if bot lacks access yet)
  for (const guildId of allowed) {
    try {
      await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body });
      console.log(`Guild ${guildId}: /video, /help`);
    } catch (err) {
      console.warn(
        `Guild ${guildId}: no se pudieron registrar comandos (${err.message || err}). ` +
          'Comprueba que el ID es de un servidor (no canal) y que el bot ya está invitado allí.'
      );
    }
  }

  // Clear commands on any other guild the bot somehow joined
  for (const guildId of presentGuildIds) {
    if (allowed.has(guildId)) continue;
    try {
      await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body: [] });
      console.log(`Guild ${guildId}: commands cleared (not allowlisted)`);
    } catch (err) {
      console.warn(`Guild ${guildId}: no se pudo limpiar comandos:`, err.message || err);
    }
  }
}

if (require.main === module) {
  registerCommands().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { registerCommands };
