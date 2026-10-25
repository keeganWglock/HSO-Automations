import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { fetchSendableChannel, loadTemplate } from '../utils/components.js';
import { getGuildConfig } from '../utils/config.js';
import { canUseStaffCommands } from '../utils/permissions.js';
import { clearPending, getPending, setPending } from '../utils/careersDb.js';

// ---------------------------------------------------------------------------
// CAREERS SETTINGS - edit these
// ---------------------------------------------------------------------------
// Channel where finished applications are sent for review (with Approve / Deny buttons).
const APPLICATION_CHANNEL_ID = '1563972843916492842';
// Role IDs given to a user when their application is approved.
const APPROVE_ROLES = ['1563753564059336787', '1563753564059336786', '1563753564059336785'];
// How long a waiting application blocks a second one (in case its message was deleted).
const PENDING_EXPIRY_DAYS = 1;

const CAREERS_FILE = 'careersmessage.json';
const DM_FILE = 'careersdmmessage.json';
const APPROVE_FILE = 'careersapprovemessage.json';
const DENY_FILE = 'careersdenymessage.json';

// `label` (max 45) and `description` (max 100) are what the applicant sees in the form.
// `question` is the full wording shown to reviewers in the application log (max 256).
const QUESTIONS = [
  {
    id: 'q2',
    label: 'Why do you want to work with HCSO?',
    question: 'Why do you want to work with HCSO?',
    min: 20,
  },
  {
    id: 'q3',
    label: 'Why should we accept you over others?',
    description: 'Answer in 2+ sentences.',
    question: 'Why should we accept you over other applicants? (2+ sentences)',
    min: 40,
  },
  {
    id: 'q4',
    label: '10-11 Situation',
    description: 'You pull someone over for felony speeding (3+ sentences)',
    question:
      'You pull someone over for felony speeding. How do you handle the situation? (3+ sentences)',
    min: 60,
  },
  {
    id: 'q5',
    label: 'What is a 10-80?',
    description: "Explain what a 10-80 is.",
    question:
      "What is a 10-80?",
    min: 60,
  },
  {
    id: 'q6',
    label: 'What is a 10-26?',
    description: "Explain what a 10-26 is.",
    question:
      "What is a 10-26? (3+ sentences)",
    min: 60,
  },
  {
    id: 'q7',
    label: 'Is there anything else you would want us to know?',
    description: "Anything else you want us to know?",
    question:
      "Is there anything else you would want us to know? (3+ sentences)",
    min: 60,
  },
];
const ACTIVITY_QUESTION = 'How active are you on a scale from 1-10 (with 10 being the most active)?';
const ANSWER_MAX = 800;

const MODAL_ID = 'careers:modal';
const DENY_MODAL_PREFIX = 'careers:denymodal:';
const isValidId = (id) => /^\d{17,20}$/.test(id);

export function isCareersInteraction(customId) {
  return customId.startsWith('careers:');
}

// Adds the Apply button under the text if careersmessage.json doesn't already have one.
function ensureApplyButton(components) {
  if (JSON.stringify(components).includes('"careers:apply"')) return components;
  const row = { type: 1, components: [{ type: 2, style: 3, label: 'Apply', custom_id: 'careers:apply' }] };
  const container = components.find((c) => c?.type === 17 && Array.isArray(c.components));
  if (!container) {
    components.push(row);
    return components;
  }
  let lastText = -1;
  container.components.forEach((c, i) => {
    if (c?.type === 10) lastText = i;
  });
  container.components.splice(lastText + 1, 0, row);
  return components;
}

function walkText(nodes, visit) {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 10 && typeof node.content === 'string') visit(node);
    if (Array.isArray(node.components)) walkText(node.components, visit);
  }
}

// Sends one of the DM templates. Returns null on success or a short reason on failure.
// `reason` (denials only) fills {reason}; if the template has no {reason}, a
// "Application Denied because:" line is added under the last text.
async function sendTemplateDm(user, fileName, reason = null) {
  try {
    const components = await loadTemplate(fileName);
    const hasReasonPlaceholder = JSON.stringify(components).includes('{reason}');
    walkText(components, (node) => {
      node.content = node.content
        .replaceAll('{user}', () => `<@${user.id}>`)
        .replaceAll('{username}', () => user.username)
        .replaceAll('{reason}', () => reason ?? '');
    });
    if (reason && !hasReasonPlaceholder) {
      const line = { type: 10, content: `**Application Denied because:** ${reason}` };
      const container = components.find((c) => c?.type === 17 && Array.isArray(c.components));
      if (container) {
        let lastText = -1;
        container.components.forEach((c, i) => {
          if (c?.type === 10) lastText = i;
        });
        container.components.splice(lastText + 1, 0, line);
      } else {
        components.push(line);
      }
    }
    await user.send({ components, flags: MessageFlags.IsComponentsV2 });
    return null;
  } catch (error) {
    console.warn(`[CAREERS] Could not DM ${user.id} (${fileName}): ${error.message}`);
    return error.code === 50007 ? 'their DMs are closed' : error.message;
  }
}

function buildModal() {
  const modal = new ModalBuilder().setCustomId(MODAL_ID).setTitle('HCSO Application');

  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel('How active are you?')
      .setDescription('Scale of 1-10, with 10 being the most active.')
      .setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId('activity')
          .setPlaceholder('Select 1-10')
          .setRequired(true)
          .addOptions(
            Array.from({ length: 10 }, (_, i) => ({
              label: i === 0 ? '1 (least active)' : i === 9 ? '10 (most active)' : String(i + 1),
              value: String(i + 1),
            })),
          ),
      ),
  );

  for (const q of QUESTIONS) {
    const label = new LabelBuilder()
      .setLabel(q.label)
      .setTextInputComponent(
        new TextInputBuilder()
          .setCustomId(q.id)
          .setStyle(TextInputStyle.Paragraph)
          .setMinLength(q.min)
          .setMaxLength(ANSWER_MAX)
          .setRequired(true),
      );
    if (q.description) label.setDescription(q.description);
    modal.addLabelComponents(label);
  }
  return modal;
}

function buildDenyModal(applicantId) {
  return new ModalBuilder()
    .setCustomId(`${DENY_MODAL_PREFIX}${applicantId}`)
    .setTitle('Deny Application')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Why is this application denied?')
        .setDescription('This reason is sent to the applicant.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('reason')
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(5)
            .setMaxLength(500)
            .setRequired(true),
        ),
    );
}

export async function handleButton(interaction) {
  if (!interaction.inGuild()) return;

  if (interaction.customId === 'careers:apply') {
    if (!isValidId(APPLICATION_CHANNEL_ID)) {
      return interaction.reply({
        content: '❌ Applications are not set up yet (APPLICATION_CHANNEL_ID in commands/careers.js).',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (getPending(interaction.user.id, PENDING_EXPIRY_DAYS * 86_400_000)) {
      return interaction.reply({
        content: '❌ You already have an application waiting for review.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.showModal(buildModal());
  }

  const [, decision, applicantId] = interaction.customId.split(':');
  if (decision === 'approve' && isValidId(applicantId)) {
    return reviewApplication(interaction, 'approve', applicantId);
  }
  if (decision === 'deny' && isValidId(applicantId)) {
    // Denying asks for a reason first; the decision is made when the form is submitted.
    if (!canUseStaffCommands(interaction.member, getGuildConfig(interaction.guildId))) {
      return interaction.reply({ content: "You don't have permission to review applications.", flags: MessageFlags.Ephemeral });
    }
    if (deciding.has(interaction.message.id)) {
      return interaction.reply({ content: 'This application is already being processed.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildDenyModal(applicantId));
  }
}

// ---------------------------------------------------------------------------
// Submitting an application
// ---------------------------------------------------------------------------
export async function handleModal(interaction) {
  if (interaction.customId.startsWith(DENY_MODAL_PREFIX)) {
    const applicantId = interaction.customId.slice(DENY_MODAL_PREFIX.length);
    if (!interaction.inGuild() || !isValidId(applicantId) || !interaction.isFromMessage()) return;
    const reason = interaction.fields.getTextInputValue('reason').trim();
    if (!reason) {
      return interaction.reply({ content: '❌ Please give a reason for the denial.', flags: MessageFlags.Ephemeral });
    }
    return reviewApplication(interaction, 'deny', applicantId, reason);
  }
  if (interaction.customId !== MODAL_ID) return;
  const user = interaction.user;

  if (!interaction.inGuild() || !isValidId(APPLICATION_CHANNEL_ID)) {
    return interaction.reply({ content: '❌ Applications are not set up yet.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reply = (content) => interaction.editReply({ content });

  if (getPending(user.id, PENDING_EXPIRY_DAYS * 86_400_000)) {
    return reply('❌ You already have an application waiting for review.');
  }

  const activity = interaction.fields.getStringSelectValues('activity')[0];
  if (!activity) return reply('❌ Please select how active you are.');
  const answers = QUESTIONS.map((q) => ({
    question: q.question,
    answer: interaction.fields.getTextInputValue(q.id).trim(),
  }));
  if (answers.some((a) => !a.answer)) return reply('❌ Every question needs an answer.');

  const embed = new EmbedBuilder()
    .setTitle('New Career Application')
    .setColor('#fbbc04')
    .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
    .setThumbnail(user.displayAvatarURL())
    .setDescription(`**Applicant:** <@${user.id}> (${user.username})\n**Applicant ID:** ${user.id}`)
    .addFields(
      { name: ACTIVITY_QUESTION, value: `${activity}/10`, inline: false },
      ...answers.map((a) => ({ name: a.question, value: a.answer, inline: false })),
    )
    .setFooter({ text: `Applicant ID: ${user.id}` })
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`careers:approve:${user.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`careers:deny:${user.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );

  let message;
  try {
    const channel = await fetchSendableChannel(interaction.client, APPLICATION_CHANNEL_ID);
    message = await channel.send({ embeds: [embed], components: [buttons], allowedMentions: { parse: [] } });
  } catch (error) {
    console.error('[CAREERS] Could not post the application:', error);
    return reply(`❌ Couldn't submit your application: ${error.message}`);
  }
  setPending(user.id, message.id);

  const dmProblem = await sendTemplateDm(user, DM_FILE);
  return reply(
    `✅ Your application was submitted.${dmProblem ? `\n⚠️ I couldn't send you a confirmation DM (${dmProblem}).` : ''}`,
  );
}

// ---------------------------------------------------------------------------
// Approving / denying an application
// ---------------------------------------------------------------------------
const deciding = new Set(); // application message IDs currently being handled

async function reviewApplication(interaction, decision, applicantId, reason = null) {
  const ephemeral = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

  if (!canUseStaffCommands(interaction.member, getGuildConfig(interaction.guildId))) {
    return ephemeral("You don't have permission to review applications.");
  }
  const messageId = interaction.message.id;
  if (deciding.has(messageId)) return ephemeral('This application is already being processed.');
  deciding.add(messageId);

  try {
    await interaction.deferUpdate();
    const approved = decision === 'approve';
    const notes = [];

    if (approved) {
      const roleIds = APPROVE_ROLES.filter(isValidId);
      if (roleIds.length === 0) {
        notes.push('⚠️ No approve roles are configured (APPROVE_ROLES in commands/careers.js), so no roles were given.');
      } else {
        const member = await interaction.guild.members.fetch(applicantId).catch(() => null);
        if (!member) {
          notes.push('⚠️ The applicant is not in the server, so no roles were given.');
        } else {
          try {
            await member.roles.add(roleIds, `Career application approved by ${interaction.user.username}`);
          } catch (error) {
            console.error('[CAREERS] Could not add roles:', error);
            notes.push(`⚠️ I couldn't give the roles: ${error.message}`);
          }
        }
      }
    }

    const applicant = await interaction.client.users.fetch(applicantId).catch(() => null);
    if (applicant) {
      const dmProblem = await sendTemplateDm(applicant, approved ? APPROVE_FILE : DENY_FILE, approved ? null : reason);
      if (dmProblem) notes.push(`⚠️ I couldn't DM the applicant (${dmProblem}).`);
    } else {
      notes.push("⚠️ I couldn't find the applicant to DM them.");
    }

    clearPending(applicantId);

    const updated = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(approved ? '#57f287' : '#ed4245')
      .addFields({
        name: approved ? 'Approved' : 'Denied',
        value:
          `By <@${interaction.user.id}> on <t:${Math.floor(Date.now() / 1000)}:F>` +
          (!approved && reason ? `\n**Reason:** ${reason}` : ''),
        inline: false,
      });
    await interaction.editReply({ embeds: [updated], components: [] });

    if (notes.length) await interaction.followUp({ content: notes.join('\n'), flags: MessageFlags.Ephemeral });
  } catch (error) {
    console.error('[CAREERS] Review failed:', error);
    await interaction.followUp({ content: `❌ Something went wrong: ${error.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  } finally {
    deciding.delete(messageId);
  }
}

// "-careers" posts the careers message (with the Apply button) in the current channel.
export default {
  name: 'careers',
  description: 'Posts the careers message from data/careersmessage.json.',
  async execute(message) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) return;
    try {
      const components = ensureApplyButton(await loadTemplate(CAREERS_FILE));
      await message.channel.send({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
      await message.reply(`Couldn't post the careers message: ${error.message}`).catch(() => {});
    }
  },
};
