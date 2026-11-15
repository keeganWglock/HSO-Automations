import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } from 'discord.js';

export default {
  name: 'assistance',
  description: 'Posts the support type selector for general and high-ranking support tickets.',
  async execute(message) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) return;

    const embed = new EmbedBuilder()
      .setTitle('Support')
      .setDescription('Select the kind of support you need below.')
      .setColor('#00a8fc');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket:create:general').setLabel('General Support').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ticket:create:hr').setLabel('High Ranking Support').setStyle(ButtonStyle.Secondary),
    );

    await message.channel.send({ embeds: [embed], components: [row] });
  },
};
