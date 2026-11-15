import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
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

const ACTIVITY_QUESTION = 'How active are you on a scale from 1-10 (with 10 being the most active)?';

const QUESTIONS = [
  {
    id: 'activity',
    question: ACTIVITY_QUESTION,
  },
  {
    id: 'q2',
    question: 'Why do you want to work with HCSO?',
  },
  {
    id: 'q3',
    question: 'Why should we accept you over other applicants? (2+ sentences)',
  },
  {
    id: 'q4',
    question: 'You pull someone over for felony speeding. How do you handle the situation? (3+ sentences)',
  },
  {
    id: 'q5',
    question: 'What is a 10-80?',
  },
  {
    id: 'q6',
    question: 'What is a 10-26? (3+ sentences)',
  },
  {
    id: 'q7',
    question: 'Is there anything else you would want us to know? (3+ sentences)',
  },
];

const HR_QUESTIONS = [
  ...QUESTIONS,
  {
    id: 'q8',
    question: 'Why do you believe you are a strong fit for a high-ranking position within HCSO?',
  },
];

const APPLICATION_TYPES = {
  general: {
    label: 'General Application',
    title: 'New General Career Application',
    questions: QUESTIONS,
  },
  hr: {
    label: 'High Ranking Application',
    title: 'New High Ranking Career Application',
    questions: HR_QUESTIONS,
  },
};

const MODAL_ID = 'careers:modal';
const DENY_MODAL_PREFIX = 'careers:denymodal:';
const isValidId = (id) => /^\d{17,20}$/.test(id);

export function isCareersInteraction(customId) {
  return customId.startsWith('careers:');
}

function ensureApplyButton(components) {
  const required = [
    { type: 2, style: 3, label: 'General Application', custom_id: 'careers:apply:general' },
    { type: 2, style: 2, label: 'High Ranking Application', custom_id: 'careers:apply:hr' },
  ];
  const json = JSON.stringify(components);
  if (required.every((button) => json.includes(`"${button.custom_id}"`))) return components;

  const row = { type: 1, components: required };
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

async function collectApplicationAnswers(user, questions) {
  const dmChannel = await user.createDM();
  const answers = [];

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    while (true) {
      await dmChannel.send(`**Question ${index + 1}/${questions.length}**\n${question.question}`);
      const collected = await dmChannel.awaitMessages({
        filter: (message) => message.author.id === user.id && !message.author.bot,
        max: 1,
        time: 600_000,
        errors: ['time'],
      });
      const answer = collected.first()?.content?.trim();
      if (answer && answer.length > 0) {
        answers.push({ question: question.question, answer });
        break;
      }
      await dmChannel.send('❌ Please provide an answer before continuing.');
    }
  }

  return answers;
}

async function startApplication(interaction, type = 'general') {
  const config = APPLICATION_TYPES[type] ?? APPLICATION_TYPES.general;
  const sendReply = async (content) => {
    if (interaction.deferred || interaction.replied) {
      return interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ content, flags: MessageFlags.Ephemeral });
  };

  try {
    await sendReply('I sent the application questions in your DMs. Please answer each one there.');
    const answers = await collectApplicationAnswers(interaction.user, config.questions);

    const activityAnswer = answers.find((answer) => answer.question === ACTIVITY_QUESTION)?.answer ?? 'Not provided';
    const embed = new EmbedBuilder()
      .setTitle(config.title)
      .setColor(type === 'hr' ? '#f39c12' : '#fbbc04')
      .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
      .setThumbnail(interaction.user.displayAvatarURL())
      .setDescription(`**Applicant:** <@${interaction.user.id}> (${interaction.user.username})\n**Applicant ID:** ${interaction.user.id}`)
      .addFields(
        { name: ACTIVITY_QUESTION, value: activityAnswer, inline: false },
        ...answers
          .filter((answer) => answer.question !== ACTIVITY_QUESTION)
          .map((answer) => ({ name: answer.question, value: answer.answer, inline: false })),
      )
      .setFooter({ text: `Applicant ID: ${interaction.user.id}` })
      .setTimestamp();

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`careers:approve:${interaction.user.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`careers:deny:${interaction.user.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
    );

    const channel = await fetchSendableChannel(interaction.client, APPLICATION_CHANNEL_ID);
    const message = await channel.send({ embeds: [embed], components: [buttons], allowedMentions: { parse: [] } });
    setPending(interaction.user.id, message.id);

    const dmProblem = await sendTemplateDm(interaction.user, DM_FILE);
    await sendReply(
      `✅ Your ${config.label.toLowerCase()} was submitted.${dmProblem ? `\n⚠️ I couldn't send you a confirmation DM (${dmProblem}).` : ''}`,
    );
  } catch (error) {
    console.error('[CAREERS] Could not submit the DM application:', error);
    await sendReply(`❌ ${error.message || 'I could not finish your application. Please try again.'}`);
  }
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

  const buttonType = interaction.customId === 'careers:apply:hr' ? 'hr' : 'general';
  if (interaction.customId === 'careers:apply' || interaction.customId === 'careers:apply:general' || interaction.customId === 'careers:apply:hr') {
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
    return startApplication(interaction, buttonType);
  }

  const [, decision, applicantId] = interaction.customId.split(':');
  if (decision === 'approve' && isValidId(applicantId)) {
    return reviewApplication(interaction, 'approve', applicantId);
  }
  if (decision === 'deny' && isValidId(applicantId)) {
    if (!canUseStaffCommands(interaction.member, getGuildConfig(interaction.guildId))) {
      return interaction.reply({ content: "You don't have permission to review applications.", flags: MessageFlags.Ephemeral });
    }
    if (deciding.has(interaction.message.id)) {
      return interaction.reply({ content: 'This application is already being processed.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildDenyModal(applicantId));
  }
}

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
