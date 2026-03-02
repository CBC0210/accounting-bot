const { EmbedBuilder } = require('discord.js');

async function sendEmbed(message, { title, fields, footer, color = 0x00b894 }) {
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
  
  return await message.reply({ embeds: [embed] });
}

module.exports = { sendEmbed };
