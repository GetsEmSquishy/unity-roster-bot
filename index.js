// index.js
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

/**
 * UNITY RAID OVERSIGHT BOT
 * - Finds the newest Raid-Helper event link in each team signup channel
 * - Fetches event JSON from https://raid-helper.dev/api/v2/events/<eventId>
 * - Counts Tanks / Healers / Melee / Ranged (and optional melee-vs-ranged healer split)
 * - Computes NEED vs perfect comp (2 tanks, 4 healers, rest DPS based on raidSize)
 * - Edits ONE dashboard message (so it never gets buried)
 *
 * Required Railway Variables:
 * BOT_TOKEN
 * GUILD_ID
 * DASHBOARD_CHANNEL_ID
 * DASHBOARD_MESSAGE_ID
 */

const CONFIG = {
  guildId: process.env.GUILD_ID,
  dashboardChannelId: process.env.DASHBOARD_CHANNEL_ID,
  dashboardMessageId: process.env.DASHBOARD_MESSAGE_ID,

  // how many recent messages to scan in each signup channel to find the newest raid-helper link
  lookbackMessages: 75,

  // Teams + signup channels (Discord channel IDs)
  teams: [
    { name: "SOLOMONO", signupChannelId: "1071192840408940626", raidSize: 20 },
    { name: "CRIT HAPPENS", signupChannelId: "1248666830810251354", raidSize: 20 },
    { name: "EARLY BIRD SPECIAL", signupChannelId: "1216844831767396544", raidSize: 20 },
    { name: "WEEKEND WARRIORS", signupChannelId: "1338703521138081902", raidSize: 20 },
  ],

  // Perfect comp
  targets: { tanks: 2, healers: 4 },

  // Optional: split healers into "melee" vs "ranged" by spec
  // Holy Paladin sometimes shows as "Holy1" in Raid-Helper JSON.
  meleeHealerSpecs: new Set(["Mistweaver", "Holy", "Holy1"]),
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function extractEventIdFromMessage(msg) {
  // 1) Link in plain message content
  const m1 = msg.content?.match(/raid-helper\.dev\/event\/(\d+)/i);
  if (m1) return m1[1];

  // 2) Link inside embeds (common)
  for (const emb of msg.embeds ?? []) {
    const url = emb.url || "";
    const m2 = url.match(/raid-helper\.dev\/event\/(\d+)/i);
    if (m2) return m2[1];
  }
  return null;
}

async function findLatestRaidHelperEventId(signupChannel) {
  const messages = await signupChannel.messages.fetch({
    limit: CONFIG.lookbackMessages,
  });

  for (const msg of messages.values()) {
    const eventId = extractEventIdFromMessage(msg);
    if (eventId) return eventId;
  }
  return null;
}

async function fetchRaidHelperEvent(eventId) {
  const url = `https://raid-helper.dev/api/v2/events/${eventId}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(
      `Raid-Helper fetch failed: ${res.status} ${await res.text()}`
    );
  }
  return await res.json();
}

function countRoles(eventJson) {
  const signUps = Array.isArray(eventJson.signUps) ? eventJson.signUps : [];

  // Ignore special buckets and anything not primary
  const ignoreClass = new Set(["Late", "Bench", "Tentative", "Absence"]);
  const primaries = signUps.filter((s) => {
    const cn = String(s.className || "");
    const st = String(s.status || "primary").toLowerCase();
    return !ignoreClass.has(cn) && st === "primary";
  });

  const counts = {
    tanks: 0,
    healers: 0,
    melee: 0,
    ranged: 0,
    mh: 0, // melee healers
    rh: 0, // ranged healers
  };

  for (const s of primaries) {
    const role = String(s.roleName || "");
    if (role === "Tanks") counts.tanks++;
    else if (role === "Healers") {
      counts.healers++;
      const spec = String(s.specName || "");
      if (CONFIG.meleeHealerSpecs.has(spec)) counts.mh++;
      else counts.rh++;
    } else if (role === "Melee") counts.melee++;
    else if (role === "Ranged") counts.ranged++;
  }

  return counts;
}

function needLine(label, have, target) {
  const need = Math.max(0, target - have);
  return need === 0
    ? `${label}: FULL (${have}/${target})`
    : `${label}: NEED ${need} (${have}/${target})`;
}

function renderDashboard(teamSummaries) {
  const now = new Date();
  const weekOf = now.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const lines = [];
  lines.push(`UNITY RAID OVERSIGHT — Week of ${weekOf}`);
  lines.push("");

  for (const s of teamSummaries) {
    const when = new Date(s.startTime * 1000).toLocaleString("en-US", {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });

    const raidSize = s.raidSize ?? 20;
    const tanksTarget = CONFIG.targets.tanks;
    const healsTarget = CONFIG.targets.healers;
    const dpsTarget = Math.max(0, raidSize - (tanksTarget + healsTarget));
    const dpsHave = s.counts.melee + s.counts.ranged;

    lines.push(`${s.teamName} (${when})`);
    lines.push(needLine("Tank", s.counts.tanks, tanksTarget));
    lines.push(
      needLine("Heals", s.counts.healers, healsTarget) +
        `  [Melee ${s.counts.mh} | Ranged ${s.counts.rh}]`
    );
    lines.push(
      needLine("DPS", dpsHave, dpsTarget) +
        `  [Melee ${s.counts.melee} | Ranged ${s.counts.ranged}]`
    );
    lines.push("");
  }

  return "```ansi\n" + lines.join("\n") + "\n```";
}

async function updateDashboard() {
  const dashboardChannel = await client.channels.fetch(CONFIG.dashboardChannelId);
  if (!dashboardChannel || !dashboardChannel.isTextBased()) {
    throw new Error("Dashboard channel not found or not text-based.");
  }

  const teamSummaries = [];

  for (const team of CONFIG.teams) {
    const signupChannel = await client.channels.fetch(team.signupChannelId);
    if (!signupChannel || !signupChannel.isTextBased()) {
      console.log(`[${team.name}] Signup channel not found or not text-based.`);
      continue;
    }

    const eventId = await findLatestRaidHelperEventId(signupChannel);
    if (!eventId) {
      console.log(
        `[${team.name}] No raid-helper event link found in last ${CONFIG.lookbackMessages} messages.`
      );
      continue;
    }

    const eventJson = await fetchRaidHelperEvent(eventId);
    const counts = countRoles(eventJson);

    teamSummaries.push({
      teamName: team.name,
      startTime: eventJson.startTime,
      counts,
      raidSize: team.raidSize ?? 20,
    });

    console.log(`[${team.name}] Event ${eventId} counted:`, counts);
  }

  teamSummaries.sort((a, b) => a.startTime - b.startTime);

  const content = renderDashboard(teamSummaries);

  const msg = await dashboardChannel.messages.fetch(CONFIG.dashboardMessageId);
  await msg.edit(content);

  console.log("Dashboard updated.");
}

async function registerCommands() {
  const cmd = new SlashCommandBuilder()
    .setName("refreshdashboard")
    .setDescription("Refresh the raid oversight dashboard");

  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, CONFIG.guildId),
    { body: [cmd.toJSON()] }
  );

  console.log("Slash command registered: /refreshdashboard");
}

client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await registerCommands();

  // Update on boot + every 2 hours
  await updateDashboard();
  setInterval(updateDashboard, 2 * 60 * 60 * 1000);
});

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  if (i.commandName === "refreshdashboard") {
    await i.deferReply({ ephemeral: true });
    await updateDashboard();
    await i.editReply("Dashboard refreshed ✅");
  }
});

client.login(process.env.BOT_TOKEN);
