import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { loadTemplate } from '../utils/components.js';

const MESSAGE_FILE = 'pimessage.json';

export default {
  name: 'pi',
  aliases: ['probation information', 'p-i'],
  description: 'Posts the probation information announcement from data/pimessage.json.',
  async execute(message) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) return;
    try {
      const components = await loadTemplate(MESSAGE_FILE);
      await message.channel.send({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
      await message.reply(`Couldn't send the probation information message: ${error.message}`).catch(() => {});
    }
  },
};
