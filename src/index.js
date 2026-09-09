require('dotenv').config();

const { Client, Events, GatewayIntentBits } = require('discord.js');
const { getConfig } = require('./config');
const { registerCommands } = require('./register-commands');
const videoCommand = require('./commands/video');
const helpCommand = require('./commands/help');

const commands = {
  video: videoCommand,
  help: helpCommand,
};

async function main() {
  const config = getConfig();
  if (!config.token || !config.clientId) {
    console.error('Faltan DISCORD_BOT_TOKEN o DISCORD_CLIENT_ID en .env');
    process.exit(1);
  }

  await registerCommands();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`Listo como ${c.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

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
