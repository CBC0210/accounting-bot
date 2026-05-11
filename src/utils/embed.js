const { EmbedBuilder } = require('discord.js');

async function sendEmbed(message, { title, fields, footer, color = 0x00b894, components }) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title);

  if (fields) {
    fields.forEach(field => {
      embed.addFields({
        name: field.name,
        value: field.value,
        inline: field.inline || false,
      });
    });
  }

  if (footer) {
    embed.setFooter({ text: footer });
  }

  embed.setTimestamp();

  const replyPayload = { embeds: [embed] };
  if (components && components.length) replyPayload.components = components;

  return await message.reply(replyPayload);
}

module.exports = { sendEmbed };
