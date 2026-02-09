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
 * UNITY RAID OVERSIGHT BOT (Paged message fetch)
 *
 * Required Railway Variables:
 * BOT_TOKEN
 * GUILD_ID
 * DASHBOARD_CHANNEL_ID
 *
 * Optional:
 * DASHBOARD_MESSAGE_ID (must be authored by bot; if missing, bot creates one)
 */

const CONFIG = {
  guildId: process.env.GUILD_ID,
  dashboardChannelId: process.env.DASHBOARD_CHANNEL_ID,
  dashboardMessageId: process.env.DASHBOARD_MESSAGE_ID || "",

  // Total messages to scan in each signup channel (we'll fetch in pages of 100)
  LOOKBACK_TOTAL: 300,

  teams: [
    { name: "SOLOMONO", signupChannelId: "1071192840408940626", raidSize: 20 },
    { name: "CRIT HAPPENS", signupChannelId: "1248666830810251354", raidSize: 20 },
    { name: "EARLY BIRD SPECIAL", signupChannelId: "1216844831767396544", raidSize: 20 },
    { name: "WEEKEND WARRIORS", signupChannelId: "1338703521138081902", raidSize: 20 },
  ],

  targets: { tanks: 2, healers: 4 },
  meleeHealerSpecs: new Set(["Mistweaver", "Holy", "Holy1"]),
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// -------------------- Robust event link extraction --------------------

function extractEventIdFromText(text) {
  if (!text) return null;
  const m = String(text).match(/raid-helper\.dev\/event\/(\d{10,30})/i);
  return m ? m[1] : null;
}

function extractEventIdFromMessage(msg) {
  // 1) Direct content
  let eventId = extractEventIdFromText(msg.content);
  if (eventId) return eventId;

  // 2) Embeds: url/title/description/fields/author/footer
  for (const emb of msg.embeds ?? []) {
    eventId = extractEventIdFromText(emb.url);
    if (eventId) return eventId;

    eventId = extractEventIdFromText(emb.title);
    if (eventId) return eventId;

    eventId = extractEventIdFromText(emb.description);
    if (eventId) return eventId;

    if (Array.isArray(emb.fields)) {
      for (const f of emb.fields) {
        eventId = extractEventIdFromText(f?.name);
        if (eventId) return eventId;

        eventId = extractEventIdFromText(f?.value);
        if (eventId) return eventId;
      }
    }

    eventId = extractEventIdFromText(emb.author?.url);
    if (eventId) return eventId;

    eventId = extractEventIdFromText(emb.footer?.text);
    if (eventId) return eventId;
  }

  // 3) Buttons (components) may contain link URLs
  for (const row of msg.components ?? []) {
    for (const c of row.components ?? []) {
      eventId = extractEventIdFromText(c.url);
      if (eventId) return eventId;
    }
  }

  return null;
}

// -------------------- Discord-safe paged message fetch --------------------
// Discord limit per request is max 100. We'll page backwards using "before".
async function fetchRecentMessagesPaged(textChannel, totalDesired) {
  const total = Math.max(0, Number(totalDesired) || 0);
  const all = [];

  let beforeId = undefined;

  while (all.length < total) {
    const remaining = total - all.length;
    const limit = Math.min(100, remaining);

    const batch = await textChannel.messages.fetch({
      limit,
      ...(beforeId ? { before: beforeId } : {}),
    });

    if (batch.size === 0) break;

    // Add to array in fetch order (newest->older)
    const batchArr = Array.from(batch.values());
    all.push(...batchArr);

    // Set beforeId to the oldest message in this batch for next page
    beforeId = batchArr[batchArr.length - 1].id;

    // Safety: if Discord returns fewer than requested, we're near the end
    if (batch.size < limit) break;
  }

  return all;
}

async function findLatestRaidHelperEventId(signupChannel) {
  const messages = await fetchRecentMessagesPaged(signupChannel, CONFIG.LOOKBACK_TOTAL);

  for (const msg of messages) {
    const eventId = extractEventIdFromMessage(msg);
    if (eventId) return eventId;
  }
  return null;
}

// -------------------- Raid-Helper API --------------------

async function fetchRaidHelperEvent(eventId) {
  const url = `https://raid-helper.dev/api/v2/events/${eventId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Raid-Helper fetch failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

function countRoles(eventJson) {
  const signUps = Array.isArray(eventJson.signUps) ? eventJson.signUps : [];

  const ignoreClass = new Set(["Late", "Bench", "Tentative", "Absence"]);
  const primaries = signUps.filter((s) => {
    const cn = String(s.className || "");
    const st = String(s.status || "primary").toLowerCase();
    return !ignoreClass.has(cn) && st === "primary";
  });

  const counts = { tanks: 0, healers: 0, melee: 0, ranged: 0, mh: 0, rh: 0 };

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

// -------------------- Rendering --------------------

function needLine(label, have, target) {
  const need = Math.max(0, target - have);
  return need === 0
    ? `${label}: FULL (${have}/${target})`
    : `${label}: NEED ${need} (${have}/${target})`;
}

function renderDashboardAnsi(teamSummaries) {
  const now = new Date();
  const weekOf = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  const lines = [];
  lines.push(`UNITY RAID OVERSIGHT — Week of ${weekOf}`);
  lines.push("");

  if (teamSummaries.length === 0) {
    lines.push("No upcoming Raid-Helper events found in signup channels.");
    lines.push("If unexpected: verify signup posts exist, or pin them (we can add pinned-first scanning next).");
    return "```ansi\n" + lines.join("\n") + "\n```";
  }

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

// -------------------- Dashboard message management --------------------

async function ensureDashboardMessage(dashboardChannel) {
  if (CONFIG.dashboardMessageId && CONFIG.dashboardMessageId.trim().length > 0) {
    try {
      return await dashboardChannel.messages.fetch(CONFIG.dashboardMessageId.trim());
    } catch {
      console.log("DASHBOARD_MESSAGE_ID set but not fetchable. Creating a new dashboard message.");
    }
  }

  const msg = await dashboardChannel.send("```ansi\nDashboard initializing...\n```");
  console.log("Created dashboard message. Set DASHBOARD_MESSAGE_ID to:", msg.id);
  return msg;
}

// -------------------- Main update --------------------

async function updateDashboard() {
  const dashboardChannel = await client.channels.fetch(CONFIG.dashboardChannelId);
  if (!dashboardChannel || !dashboardChannel.isTextBased()) {
    throw new Error("Dashboard channel not found or not text-based.");
  }

  const dashboardMsg = await ensureDashboardMessage(dashboardChannel);
  const teamSummaries = [];

  for (const team of CONFIG.teams) {
    try {
      const signupChannel = await client.channels.fetch(team.signupChannelId);
      if (!signupChannel || !signupChannel.isTextBased()) {
        console.log(`[${team.name}] Signup channel not found or not text-based.`);
        continue;
      }

      const eventId = await findLatestRaidHelperEventId(signupChannel);
      if (!eventId) {
        console.log(`[${team.name}] No event link found in last ${CONFIG.LOOKBACK_TOTAL} messages.`);
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

      console.log(`[${team.name}] Found event ${eventId}. Counts:`, counts);
    } catch (err) {
      console.log(`[${team.name}] Skipped due to error:`, err?.message || err);
    }
  }

  teamSummaries.sort((a, b) => a.startTime - b.startTime);

  await dashboardMsg.edit(renderDashboardAnsi(teamSummaries));
  console.log("Dashboard updated.");
}

// -------------------- Slash command --------------------

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

// -------------------- Lifecycle --------------------

client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await registerCommands();

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
