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

  // Only ONE registration surface to avoid duplicate suggestions in Discord:
  // - With DISCORD_GUILD_ID: guild-only (instant) + clear global
  // - Without: global-only + clear guild command sets
  const guildIds = new Set();
  if (config.guildId) guildIds.add(config.guildId);

  try {
    const guilds = await rest.get(Routes.userGuilds());
    for (const guild of guilds) {
      if (guild && guild.id) guildIds.add(guild.id);
    }
  } catch (err) {
    console.warn('No se pudieron listar guilds:', err.message || err);
  }

  if (config.guildId) {
    // Instant guild commands; wipe global so Discord does not show duplicates
    await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
    console.log('Global commands cleared (avoiding duplicates)');

    for (const guildId of guildIds) {
      const guildBody = guildId === config.guildId ? body : [];
      await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), {
        body: guildBody,
      });
      console.log(
        guildId === config.guildId
          ? `Guild ${guildId}: /video, /help`
          : `Guild ${guildId}: commands cleared`
      );
    }
  } else {
    // Global only; wipe any leftover guild registrations
    await rest.put(Routes.applicationCommands(config.clientId), { body });
    console.log('Global commands: /video, /help');

    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), {
        body: [],
      });
      console.log(`Guild ${guildId}: commands cleared (avoiding duplicates)`);
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
