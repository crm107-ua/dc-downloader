require('dotenv').config();

const { REST, Routes } = require('discord.js');
const { getConfig } = require('./config');
const videoCommand = require('./commands/video');
const helpCommand = require('./commands/help');

function commandBodies() {
  return [videoCommand.data.toJSON(), helpCommand.data.toJSON()];
}

function createRest(token) {
  return new REST({ version: '10' }).setToken(token);
}

async function registerGuildCommands(rest, clientId, guildId, body = commandBodies()) {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
}

async function clearGuildCommands(rest, clientId, guildId) {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
}

/**
 * Register slash commands.
 * - Allowlist set: only those guild IDs; clear commands elsewhere.
 * - Allowlist empty: every guild the bot is currently in (unrestricted mode).
 */
async function registerCommands() {
  const config = getConfig();
  if (!config.token || !config.clientId) {
    throw new Error('Faltan DISCORD_BOT_TOKEN o DISCORD_CLIENT_ID en .env');
  }

  const body = commandBodies();
  const rest = createRest(config.token);
  const allowlist = config.allowedGuildIds.map(String);
  const restricted = allowlist.length > 0;
  const allowed = new Set(allowlist);

  // Prefer guild commands over global to avoid duplicates and stale globals
  await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
  console.log('Global commands cleared');

  const presentGuildIds = new Set();
  try {
    const guilds = await rest.get(Routes.userGuilds());
    for (const guild of guilds) {
      if (guild && guild.id) presentGuildIds.add(String(guild.id));
    }
  } catch (err) {
    console.warn('No se pudieron listar guilds:', err.message || err);
  }

  const targets = restricted ? [...allowed] : [...presentGuildIds];

  for (const guildId of targets) {
    try {
      await registerGuildCommands(rest, config.clientId, guildId, body);
      console.log(`Guild ${guildId}: /video, /help`);
    } catch (err) {
      console.warn(
        `Guild ${guildId}: no se pudieron registrar comandos (${err.message || err}). ` +
          'Comprueba que el ID es de un servidor (no canal) y que el bot ya está invitado allí.'
      );
    }
  }

  if (restricted) {
    for (const guildId of presentGuildIds) {
      if (allowed.has(guildId)) continue;
      try {
        await clearGuildCommands(rest, config.clientId, guildId);
        console.log(`Guild ${guildId}: commands cleared (not allowlisted)`);
      } catch (err) {
        console.warn(`Guild ${guildId}: no se pudo limpiar comandos:`, err.message || err);
      }
    }
  }
}

async function registerCommandsForGuild(guildId) {
  const config = getConfig();
  if (!config.token || !config.clientId || !guildId) return;
  const rest = createRest(config.token);
  await registerGuildCommands(rest, config.clientId, String(guildId));
  console.log(`Guild ${guildId}: /video, /help`);
}

if (require.main === module) {
  registerCommands().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { registerCommands, registerCommandsForGuild };
