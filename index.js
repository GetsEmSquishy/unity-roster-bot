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
 * - Updates Oversight Dashboard message
 * - Updates RAID RECRUITMENT thread message (emoji formatted)
 *
 * Required Railway Variables:
 * BOT_TOKEN
 * GUILD_ID
 * DASHBOARD_CHANNEL_ID
 * RECRUITMENT_THREAD_ID
 *
 * Optional:
 * DASHBOARD_MESSAGE_ID (bot-authored; else bot will create)
 * RECRUITMENT_MESSAGE_ID (bot-authored; else bot will create)
 */

const CONFIG = {
  guildId: process.env.GUILD_ID,

  dashboardChannelId: process.env.DASHBOARD_CHANNEL_ID,
  dashboardMessageId: process.env.DASHBOARD_MESSAGE_ID || "",

  recruitmentThreadId: process.env.RECRUITMENT_THREAD_ID,
  recruitmentMessageId: process.env.RECRUITMENT_MESSAGE_ID || "",

  // Total messages to scan in each signup channel
  LOOKBACK_TOTAL: 50, // your channels are locked down, so this can stay small

  // Perfect comp
  targets: { tanks: 2, healers: 4 },

  // Optional healer split by spec
  meleeHealerSpecs: new Set(["Mistweaver", "Holy", "Holy1"]),

  // Teams (signup channels + raidSize)
  teams: [
    { key: "WEEKEND", name: "WEEKEND WARRIORS", signupChannelId: "1338703521138081902", raidSize: 20 },
    { key: "SOLO", name: "SOLONOMO", signupChannelId: "1071192840408940626", raidSize: 20 },
    { key: "EARLY", name: "EARLY BIRD", signupChannelId: "1216844831767396544", raidSize: 20 },
    { key: "CRIT", name: "CRIT HAPPENS", signupChannelId: "1248666830810251354", raidSize: 20 },
    // If you add Debuff The Drama later, drop it here:
    // { key: "DEBUFF", name: "Debuff The Drama", signupChannelId: "XXXXXXXXXXXX", raidSize: 20 },
  ],

  // Static “recruitment card” info (what you showed in your example)
  recruitmentCards: {
    WEEKEND: {
      headerEmoji: ":shield:",
      time: "Thursday & Sunday Evenings",
      leader: "@snick_",
      notes: "",
    },
    SOLO: {
      headerEmoji: ":crossed_swords:",
      time: "Friday Evening",
      leader: "@vikinghammers",
      notes: "",
    },
    EARLY: {
      headerEmoji: ":sunrise:",
      time: "Tuesday & Thursday",
      leader: "@johnnynobeard",
      notes: "",
    },
    CRIT: {
      headerEmoji: ":fire:",
      time: "Friday & Sunday (Late Evening)",
      leader: "@frostynips",
      notes: "Melee DPS: Monk please",
    },
    DEBUFF: {
      headerEmoji: ":Hype:",
      time: "Saturdays",
      leader: "@jmetzger87",
      notes: "",
    },
  },
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// -------------------- Event link extraction --------------------

function extractEventIdFromText(text) {
  if (!text) return null;
  const m = String(text).match(/raid-helper\.dev\/event\/(\d{10,30})/i);
  return m ? m[1] : null;
}

function extractEventIdFromMessage(msg) {
  let eventId = extractEventIdFromText(msg.content);
  if (eventId) return eventId;

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

  for (const row of msg.components ?? []) {
    for (const c of row.components ?? []) {
      eventId = extractEventIdFromText(c.url);
      if (eventId) return eventId;
    }
  }

  return null;
}

// Discord max limit per fetch is 100; you only need 50 but we keep it safe.
async function fetchRecentMessages(textChannel, totalDesired) {
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

    const arr = Array.from(batch.values());
    all.push(...arr);
    beforeId = arr[arr.length - 1].id;

    if (batch.size < limit) break;
  }

  return all;
}

async function findLatestRaidHelperEventId(signupChannel) {
  const messages = await fetchRecentMessages(signupChannel, CONFIG.LOOKBACK_TOTAL);
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

function needCount(have, target) {
  return Math.max(0, target - have);
}

function roleBadge(need) {
  // ✅ if full, else number needed
  return need === 0 ? ":white_check_mark:" : String(need);
}

function dpsBadges(dpsNeedTotal) {
  // Your style uses :heart: for "all welcome / no cap"
  // If DPS is not full, show 1-2 style. We'll keep it simple:
  // - if 1 => "1"
  // - if 2 => "1-2"
  // - if 3+ => "3+"
  if (dpsNeedTotal <= 0) return { ranged: ":heart:", melee: ":heart:" };
  if (dpsNeedTotal === 1) return { ranged: "1", melee: "1" };
  if (dpsNeedTotal === 2) return { ranged: "1-2", melee: "1-2" };
  return { ranged: "3+", melee: "3+" };
}

function renderRecruitmentPost(teamSummaries) {
  const lines = [];

  lines.push(":clipboard: **Recruitment Key**");
  lines.push("- The number shown next to each role = how many positions are needed.");
  lines.push("- :white_check_mark: = All positions for that role are filled.");
  lines.push("- 1 (or other number) = That many spots are open.");
  lines.push("- :heart: = All are welcome for that role (no cap).");
  lines.push("");
  lines.push("");

  // Build a lookup by team key/name to keep ordering and static info
  const byName = new Map(teamSummaries.map((s) => [s.teamName.toUpperCase(), s]));

  for (const team of CONFIG.teams) {
    const card = CONFIG.recruitmentCards[team.key];
    if (!card) continue;

    const summary = byName.get(team.name.toUpperCase());

    // If no event found for that team, still print the block but show unknown
    if (!summary) {
      lines.push(`**${card.headerEmoji} ${team.name}**`);
      lines.push(`:alarm_clock: ${card.time}`);
      lines.push(`Raid Leader: ${card.leader}`);
      lines.push(`- :shield: Tank:  :grey_question:`);
      lines.push(`- :sparkles: Healer:  :grey_question:`);
      lines.push(`- :dart: Ranged DPS:  :grey_question:`);
      lines.push(`- :crossed_swords: Melee DPS:  :grey_question:`);
      lines.push("");
      lines.push("---");
      lines.push("");
      continue;
    }

    const raidSize = team.raidSize ?? 20;
    const tanksTarget = CONFIG.targets.tanks;
    const healsTarget = CONFIG.targets.healers;
    const dpsTarget = Math.max(0, raidSize - (tanksTarget + healsTarget));

    const tankNeed = needCount(summary.counts.tanks, tanksTarget);
    const healNeed = needCount(summary.counts.healers, healsTarget);

    const dpsHave = summary.counts.melee + summary.counts.ranged;
    const dpsNeed = needCount(dpsHave, dpsTarget);

    const dps = dpsBadges(dpsNeed);

    lines.push(`**${card.headerEmoji} ${team.name}**`);
    lines.push(`:alarm_clock: ${card.time}`);
    lines.push(`Raid Leader: ${card.leader}`);
    lines.push(`- :shield: Tank:  ${roleBadge(tankNeed)}`);
    lines.push(`- :sparkles: Healer:  ${roleBadge(healNeed)}`);
    lines.push(`- :dart: Ranged DPS:  ${dps.ranged}`);
    lines.push(`- :crossed_swords: Melee DPS:  ${dps.melee}`);

    // Optional notes line (ex: Monk please)
    if (card.notes && card.notes.trim().length > 0) {
      lines.push(`  - _${card.notes}_`);
    }

    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

function renderDashboardAnsi(teamSummaries) {
  const now = new Date();
  const weekOf = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  const lines = [];
  lines.push(`UNITY RAID OVERSIGHT — Week of ${weekOf}`);
  lines.push("");

  if (teamSummaries.length === 0) {
    lines.push("No upcoming Raid-Helper events found in signup channels.");
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

function needLine(label, have, target) {
  const need = Math.max(0, target - have);
  return need === 0
    ? `${label}: FULL (${have}/${target})`
    : `${label}: NEED ${need} (${have}/${target})`;
}

// -------------------- Message helpers --------------------

async function ensureBotMessage(textChannel, existingMessageId, label) {
  if (existingMessageId && existingMessageId.trim().length > 0) {
    try {
      const msg = await textChannel.messages.fetch(existingMessageId.trim());
      return msg;
    } catch {
      console.log(`${label}: Could not fetch message id. Creating a new one.`);
    }
  }

  const msg = await textChannel.send("Initializing...");
  console.log(`${label}: Created message. Set ID to: ${msg.id}`);
  return msg;
}

// -------------------- Build summaries --------------------

async function buildTeamSummaries() {
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
        console.log(`[${team.name}] No event link found.`);
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
  return teamSummaries;
}

// -------------------- Update outputs --------------------

async function updateAllOutputs() {
  const summaries = await buildTeamSummaries();

  // Dashboard
  const dashboardChannel = await client.channels.fetch(CONFIG.dashboardChannelId);
  if (!dashboardChannel || !dashboardChannel.isTextBased()) {
    throw new Error("Dashboard channel not found or not text-based.");
  }

  const dashMsg = await ensureBotMessage(dashboardChannel, CONFIG.dashboardMessageId, "DASHBOARD");
  await dashMsg.edit(renderDashboardAnsi(summaries));

  // Recruitment thread
  const thread = await client.channels.fetch(CONFIG.recruitmentThreadId);
  if (!thread || !thread.isTextBased()) {
    throw new Error("Recruitment thread not found or not text-based. Check RECRUITMENT_THREAD_ID.");
  }

  const recMsg = await ensureBotMessage(thread, CONFIG.recruitmentMessageId, "RECRUITMENT");
  await recMsg.edit(renderRecruitmentPost(summaries));

  console.log("Dashboard + Recruitment updated.");
}

// -------------------- Slash command --------------------

async function registerCommands() {
  const cmd = new SlashCommandBuilder()
    .setName("refreshdashboard")
    .setDescription("Refresh the oversight dashboard + raid recruitment post");

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

  await updateAllOutputs();
  setInterval(updateAllOutputs, 2 * 60 * 60 * 1000);
});

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  if (i.commandName === "refreshdashboard") {
    await i.deferReply({ ephemeral: true });
    await updateAllOutputs();
    await i.editReply("Dashboard + Recruitment refreshed ✅");
  }
});

client.login(process.env.BOT_TOKEN);
