require("http").createServer((req, res) => res.end("Bot online!")).listen(process.env.PORT || 3000);

const { Client, GatewayIntentBits, Partials, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes, AuditLogEvent } = require("discord.js");
const ms = require("ms");
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data.json");

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) { console.error("[DATA] load error:", e.message); }
  return { banWords: [], censorWords: [], unverifiedRoleId: null };
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ banWords: [...runtimeBanWords], censorWords: [...runtimeCensorWords], unverifiedRoleId }, null, 2));
  } catch (e) { console.error("[DATA] save error:", e.message); }
}

const config = {
  token:         process.env.TOKEN,
  logsChannel:   "1511213869375422535",
  verifyChannel: "1511214137299173417",
  verifiedRole:  "1511214378110681191",
  ownerId:       "1361502272164724796",
  secondOwnerId: "1411055056072999062",
  banWords:      ["mc","bc","bkl","lauda","lodi","mkc","laure","teri maa ki chuth"],
  censorWords:   ["abuseword"],
  nuke: {
    ban:           { count: 3, window: 10000 },
    kick:          { count: 3, window: 10000 },
    channelDelete: { count: 3, window: 10000 },
    roleDelete:    { count: 3, window: 10000 },
    webhookCreate: { count: 4, window: 10000 },
    channelCreate: { count: 5, window: 10000 },
    roleCreate:    { count: 5, window: 10000 },
  },
};

const _saved = loadData();
let unverifiedRoleId = _saved.unverifiedRoleId || null;
const runtimeBanWords    = new Set([...config.banWords,    ...(_saved.banWords    || [])]);
const runtimeCensorWords = new Set([...config.censorWords, ...(_saved.censorWords || [])]);
const whitelistedUsers   = new Set([config.ownerId, config.secondOwnerId]);
const whitelistedBots    = new Set();
const nukeTracker        = new Map();
const nukePunished       = new Set();
const afkUsers           = new Map();
const spamMap            = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildWebhooks,
  ],
  partials: [Partials.Channel],
});

function getLogsChannel(guild) { return guild.channels.cache.get(config.logsChannel) || null; }
function isOwner(id) { return id === config.ownerId || id === config.secondOwnerId; }
function isWhitelisted(id) { return isOwner(id) || whitelistedUsers.has(id); }

function trackNukeAction(userId, actionKey) {
  const threshold = config.nuke[actionKey];
  if (!threshold) return false;
  if (!nukeTracker.has(userId)) nukeTracker.set(userId, new Map());
  const userActions = nukeTracker.get(userId);
  if (!userActions.has(actionKey)) userActions.set(actionKey, []);
  const now = Date.now();
  const ts = userActions.get(actionKey).filter(t => now - t < threshold.window);
  ts.push(now);
  userActions.set(actionKey, ts);
  return ts.length >= threshold.count;
}

async function punishNuker(guild, executorId, reason) {
  if (isOwner(executorId)) return;
  const key = guild.id + ":" + executorId;
  if (nukePunished.has(key)) return;
  nukePunished.add(key);
  setTimeout(() => nukePunished.delete(key), 30000);
  try {
    const member = await guild.members.fetch(executorId).catch(() => null);
    if (member) {
      await member.roles.remove(member.roles.cache.filter(r => r.id !== guild.id)).catch(() => {});
      await member.timeout(28 * 24 * 60 * 60 * 1000, "[ANTI-NUKE] " + reason).catch(() => {});
    }
    await guild.members.ban(executorId, { reason: "[ANTI-NUKE] " + reason }).catch(() => {});
    const logs = getLogsChannel(guild);
    if (logs) {
      logs.send({
        content: "<@" + config.ownerId + ">",
        embeds: [new EmbedBuilder().setTitle("ANTI-NUKE TRIGGERED").setDescription("Action: " + reason + "\nUser: <@" + executorId + ">\nResponse: Roles stripped, Timed out, Banned").setColor("DarkRed").setTimestamp()],
      });
    }
    for (const oid of [config.ownerId, config.secondOwnerId]) {
      const owner = await client.users.fetch(oid).catch(() => null);
      if (owner) owner.send("ANTI-NUKE in " + guild.name + " - " + reason + " by <@" + executorId + "> - banned.").catch(() => {});
    }
  } catch (err) { console.error("[ANTI-NUKE]", err.message); }
}

const commands = [
  new SlashCommandBuilder().setName("afk").setDescription("Set AFK status").addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("removeafk").setDescription("Remove AFK status"),
  new SlashCommandBuilder().setName("say").setDescription("Send a message").setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages).addStringOption(o => o.setName("message").setDescription("Message").setRequired(true)),
  new SlashCommandBuilder().setName("announcement").setDescription("Post announcement").setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator).addStringOption(o => o.setName("message").setDescription("Content").setRequired(true)),
  new SlashCommandBuilder().setName("dm").setDescription("Send DM to user").setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator).addUserOption(o => o.setName("user").setDescription("User").setRequired(true)).addStringOption(o => o.setName("message").setDescription("Message").setRequired(true)),
  new SlashCommandBuilder().setName("dmall").setDescription("DM all members (owner only)").addStringOption(o => o.setName("message").setDescription("Message").setRequired(true)),
  new SlashCommandBuilder().setName("timeout").setDescription("Timeout a member").setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers).addUserOption(o => o.setName("user").setDescription("User").setRequired(true)).addStringOption(o => o.setName("duration").setDescription("e.g. 10m 1h 1d").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("untimeout").setDescription("Remove timeout").setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers).addUserOption(o => o.setName("user").setDescription("User").setRequired(true)),
  new SlashCommandBuilder().setName("kick").setDescription("Kick a member").setDefaultMemberPermissions(PermissionsBitField.Flags.KickMembers).addUserOption(o => o.setName("user").setDescription("User").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("ban").setDescription("Ban a member").setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers).addUserOption(o => o.setName("user").setDescription("User").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("unban").setDescription("Unban by ID").setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers).addStringOption(o => o.setName("userid").setDescription("User ID").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("clear").setDescription("Delete messages").setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages).addIntegerOption(o => o.setName("amount").setDescription("1-100").setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName("userinfo").setDescription("User info").addUserOption(o => o.setName("user").setDescription("User").setRequired(false)),
  new SlashCommandBuilder().setName("serverinfo").setDescription("Server info"),
  new SlashCommandBuilder().setName("filter").setDescription("Manage word filters").setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addSubcommand(s => s.setName("add").setDescription("Add word").addStringOption(o => o.setName("type").setDescription("List type").setRequired(true).addChoices({ name: "ban", value: "ban" }, { name: "censor", value: "censor" })).addStringOption(o => o.setName("word").setDescription("Word").setRequired(true)))
    .addSubcommand(s => s.setName("remove").setDescription("Remove word").addStringOption(o => o.setName("type").setDescription("List type").setRequired(true).addChoices({ name: "ban", value: "ban" }, { name: "censor", value: "censor" })).addStringOption(o => o.setName("word").setDescription("Word").setRequired(true)))
    .addSubcommand(s => s.setName("list").setDescription("Show all words")),
  new SlashCommandBuilder().setName("userwhitelist").setDescription("Whitelist users").setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addSubcommand(s => s.setName("add").setDescription("Add user").addUserOption(o => o.setName("user").setDescription("User").setRequired(true)))
    .addSubcommand(s => s.setName("remove").setDescription("Remove user").addUserOption(o => o.setName("user").setDescription("User").setRequired(true)))
    .addSubcommand(s => s.setName("list").setDescription("Show list")),
  new SlashCommandBuilder().setName("botwhitelist").setDescription("Whitelist bots").setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addSubcommand(s => s.setName("add").setDescription("Add bot").addStringOption(o => o.setName("botid").setDescription("Bot ID").setRequired(true)))
    .addSubcommand(s => s.setName("remove").setDescription("Remove bot").addStringOption(o => o.setName("botid").setDescription("Bot ID").setRequired(true)))
    .addSubcommand(s => s.setName("list").setDescription("Show list")),
  new SlashCommandBuilder().setName("nukewhitelist").setDescription("Anti-nuke whitelist").setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addSubcommand(s => s.setName("add").setDescription("Add user").addUserOption(o => o.setName("user").setDescription("User").setRequired(true)))
    .addSubcommand(s => s.setName("remove").setDescription("Remove user").addUserOption(o => o.setName("user").setDescription("User").setRequired(true)))
    .addSubcommand(s => s.setName("list").setDescription("Show list")),
  new SlashCommandBuilder().setName("security").setDescription("Security status").setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder().setName("setup-verify").setDescription("Setup verification").setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
].map(c => c.toJSON());

client.once("ready", async () => {
  console.log("Logged in as " + client.user.tag);
  try {
    const rest = new REST({ version: "10" }).setToken(config.token);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("Registered " + commands.length + " slash commands");
  } catch (err) { console.error("Command register failed:", err.message); }
});

client.on("guildAuditLogEntryCreate", async (entry, guild) => {
  const executorId = entry.executorId;
  if (!executorId || isWhitelisted(executorId)) return;
  const actionMap = {
    [AuditLogEvent.MemberBanAdd]:  "ban",
    [AuditLogEvent.MemberKick]:    "kick",
    [AuditLogEvent.ChannelDelete]: "channelDelete",
    [AuditLogEvent.RoleDelete]:    "roleDelete",
    [AuditLogEvent.WebhookCreate]: "webhookCreate",
    [AuditLogEvent.ChannelCreate]: "channelCreate",
    [AuditLogEvent.RoleCreate]:    "roleCreate",
  };
  const actionKey = actionMap[entry.action];
  if (!actionKey) return;
  if (trackNukeAction(executorId, actionKey)) {
    const labels = { ban: "Mass Ban", kick: "Mass Kick", channelDelete: "Mass Channel Delete", roleDelete: "Mass Role Delete", webhookCreate: "Mass Webhook Creation", channelCreate: "Mass Channel Creation", roleCreate: "Mass Role Creation" };
    await punishNuker(guild, executorId, labels[actionKey] || actionKey);
  }
});

client.on("guildMemberAdd", async (member) => {
  const logs = getLogsChannel(member.guild);
  if (member.user.bot) {
    if (!whitelistedBots.has(member.user.id)) {
      await member.kick("Unauthorized bot").catch(() => {});
      if (logs) logs.send({ embeds: [new EmbedBuilder().setTitle("Unauthorized Bot Kicked").setDescription(member.user.tag + " not whitelisted. Use /botwhitelist add.").setColor("Red").setTimestamp()] });
    } else {
      if (logs) logs.send({ embeds: [new EmbedBuilder().setTitle("Whitelisted Bot Joined").setDescription(member.user.tag).setColor("Green").setTimestamp()] });
    }
    return;
  }
  const ageDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
  if (ageDays < 7 && logs) {
    logs.send({ embeds: [new EmbedBuilder().setTitle("Possible Alt Account").setDescription(member.toString() + " joined. Account age: " + ageDays + " days").setColor("Orange").setTimestamp()] });
  }
  if (unverifiedRoleId) {
    const r = member.guild.roles.cache.get(unverifiedRoleId);
    if (r) await member.roles.add(r).catch(() => {});
  }
  if (config.verifyChannel) {
    const vc = member.guild.channels.cache.get(config.verifyChannel);
    if (vc) {
      vc.send({
        content: member.toString(),
        embeds: [new EmbedBuilder().setTitle("Verification Required").setDescription("Welcome to " + member.guild.name + "!\nClick the button below to verify.").setColor("Green").setTimestamp()],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("verify").setLabel("Verify Me").setStyle(ButtonStyle.Success))],
      });
    }
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  const userId = message.author.id;
  const content = message.content.toLowerCase();

  for (const [id, user] of message.mentions.users) {
    if (afkUsers.has(id)) {
      const data = afkUsers.get(id);
      await message.reply({ content: user.username + " is AFK: " + data.reason, allowedMentions: { repliedUser: false } }).catch(() => {});
    }
  }

  if (afkUsers.has(userId)) {
    afkUsers.delete(userId);
    await message.reply({ content: "Welcome back! AFK removed.", allowedMentions: { repliedUser: false } }).catch(() => {});
  }

  if (isWhitelisted(userId)) return;

  const hasBanWord    = [...runtimeBanWords].some(w => content.includes(w));
  const hasCensorWord = !hasBanWord && [...runtimeCensorWords].some(w => content.includes(w));

  if (hasBanWord) {
    await message.delete().catch(() => {});
    try { await message.member.timeout(5 * 60 * 1000, "Banned word"); } catch (_) {}
    const w = await message.channel.send({ embeds: [new EmbedBuilder().setDescription(message.author.toString() + " banned word used. Timed out 5 min.").setColor("Red")] });
    setTimeout(() => w.delete().catch(() => {}), 5000);
    const logs = getLogsChannel(message.guild);
    if (logs) logs.send({ embeds: [new EmbedBuilder().setTitle("Banned Word Detected").addFields({ name: "User", value: message.author.tag, inline: true }, { name: "Channel", value: "<#" + message.channel.id + ">", inline: true }).setColor("DarkRed").setTimestamp()] });
    return;
  }

  if (hasCensorWord) {
    await message.delete().catch(() => {});
    const w = await message.channel.send({ embeds: [new EmbedBuilder().setDescription(message.author.toString() + " message removed (filtered word).").setColor("Orange")] });
    setTimeout(() => w.delete().catch(() => {}), 5000);
    return;
  }

  const now = Date.now();
  if (!spamMap.has(userId)) spamMap.set(userId, []);
  const ts = spamMap.get(userId).filter(t => now - t < 5000);
  ts.push(now);
  spamMap.set(userId, ts);
  if (ts.length >= 5) {
    spamMap.delete(userId);
    try {
      await message.member.timeout(60 * 1000, "Spam");
      await message.channel.send({ embeds: [new EmbedBuilder().setDescription(message.author.toString() + " timed out 1 min for spamming.").setColor("Red")] });
      const logs = getLogsChannel(message.guild);
      if (logs) logs.send({ embeds: [new EmbedBuilder().setTitle("Spam Detected").addFields({ name: "User", value: message.author.tag, inline: true }, { name: "Channel", value: "<#" + message.channel.id + ">", inline: true }).setColor("Orange").setTimestamp()] });
    } catch (_) {}
  }
});

client.on("interactionCreate", async (interaction) => {

  if (interaction.isButton() && interaction.customId === "verify") {
    const role = interaction.guild.roles.cache.get(config.verifiedRole);
    if (!role) return interaction.reply({ content: "Verified role not found.", ephemeral: true });
    if (interaction.member.roles.cache.has(role.id)) return interaction.reply({ content: "Already verified!", ephemeral: true });
    try {
      await interaction.member.roles.add(role);
      if (unverifiedRoleId) {
        const ur = interaction.guild.roles.cache.get(unverifiedRoleId);
        if (ur) await interaction.member.roles.remove(ur).catch(() => {});
      }
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle("Verified!").setDescription("Welcome to " + interaction.guild.name + "! You now have full access.").setColor("Green").setTimestamp()], ephemeral: true });
      const user = interaction.user;
      const member = interaction.member;
      const accAge = Math.floor((Date.now() - user.createdTimestamp) / 86400000);
      const embed = new EmbedBuilder().setTitle("New Member Verified")
        .setThumbnail(user.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: "Username", value: user.tag, inline: true },
          { name: "User ID", value: user.id, inline: true },
          { name: "Account Created", value: "<t:" + Math.floor(user.createdTimestamp / 1000) + ":F>" },
          { name: "Joined Server", value: member.joinedAt ? "<t:" + Math.floor(member.joinedAt.getTime() / 1000) + ":F>" : "Unknown" },
          { name: "Account Age", value: accAge + " days", inline: true }
        ).setColor("Green").setTimestamp();
      for (const oid of [config.ownerId, config.secondOwnerId]) {
        const o = await client.users.fetch(oid).catch(() => null);
        if (o) o.send({ embeds: [embed] }).catch(() => {});
      }
      const logs = getLogsChannel(interaction.guild);
      if (logs) logs.send({ embeds: [embed] });
    } catch (_) {
      interaction.reply({ content: "Failed to verify. Check bot permissions.", ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  try { await interaction.deferReply({ ephemeral: true }); } catch (_) { return; }
  const cmd = interaction.commandName;

  try {

    if (cmd === "afk") {
      afkUsers.set(interaction.user.id, { reason: interaction.options.getString("reason") || "AFK" });
      return interaction.editReply({ content: "AFK set." });
    }
    if (cmd === "removeafk") {
      if (!afkUsers.has(interaction.user.id)) return interaction.editReply({ content: "You are not AFK." });
      afkUsers.delete(interaction.user.id);
      return interaction.editReply({ content: "AFK removed." });
    }
    if (cmd === "say") {
      await interaction.channel.send(interaction.options.getString("message"));
      return interaction.editReply({ content: "Sent." });
    }
    if (cmd === "announcement") {
      await interaction.channel.send({ embeds: [new EmbedBuilder().setTitle("Announcement").setDescription(interaction.options.getString("message")).setColor("Blue").setFooter({ text: "By " + interaction.user.tag }).setTimestamp()] });
      return interaction.editReply({ content: "Announcement posted." });
    }
    if (cmd === "dm") {
      const target = interaction.options.getUser("user");
      await target.send(interaction.options.getString("message"));
      return interaction.editReply({ content: "DM sent to " + target.tag });
    }
    if (cmd 
