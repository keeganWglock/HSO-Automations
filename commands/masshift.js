import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { loadTemplate } from '../utils/components.js';

const MESSAGE_FILE = 'massshiftmessage.json';

export default {
  name: 'massshift',
  aliases: ['mass shift', 'mass-shift'],
  description: 'Posts the mass shift announcement from data/massshiftmessage.json.',
  async execute(message) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) return;
    try {
      const components = await loadTemplate(MESSAGE_FILE);
      await message.channel.send({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
      await message.reply(`Couldn't send the mass shift message: ${error.message}`).catch(() => {});
    }
  },
};
