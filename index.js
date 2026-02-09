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
 *
 * - Reads each team's latest Raid-Helper event
 * - Works with BOTH Raid-Helper templates:
 *    1) roleName-based (Melee/Ranged/Tanks/Healers in roleName)
 *    2) className-based DPS buckets (Melee/Ranged stored in className, roleName may be blank)
 *
 * Outputs:
 * 1) Oversight Dashboard (channel + bot message)
 * 2) RAID RECRUITMENT thread (thread + bot message) using emoji formatting
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

  // Your signup channels are locked down, so we only need to scan a small number
  LOOKBACK_TOTAL: 50,

  // Perfect comp
  targets: { tanks: 2, healers: 4 },

  // Optional healer split by spec
  meleeHealerSpecs: new Set(["Mistweaver", "Holy", "Holy1"]),

  // Teams (signup channels + raid size)
  teams: [
    { key: "WEEKEND", name: "WEEKEND WARRIORS", signupChannelId: "1338703521138081902", raidSize: 20 },
    { key: "SOLO", name: "SOLONOMO", signupChannelId: "1071192840408940626", raidSize: 20 },
    { key: "EARLY", name: "EARLY BIRD", signupChannelId: "1216844831767396544", raidSize: 20 },
    { key: "CRIT", name: "CRIT HAPPENS", signupChannelId: "1248666830810251354", raidSize: 20 },
  ],

  // Static recruitment card info (your preferred presentation)
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

// -------------------- Counting (FIXED for both templates) --------------------

function normalize(str) {
  return String(str || "").trim().toLowerCase();
}

function countRoles(eventJson, teamNameForLogs = "") {
  const signUps = Array.isArray(eventJson.signUps) ? eventJson.signUps : [];

  const ignoreClass = new Set(["late", "bench", "tentative", "absence"]);

  // We keep totals + optional healer split
  const counts = { tanks: 0, healers: 0, melee: 0, ranged: 0, mh: 0, rh: 0 };

  // Debug: show which "buckets" are being seen
  const bucketHistogram = new Map();

  for (const s of signUps) {
    const className = normalize(s.className);
    if (ignoreClass.has(className)) continue;

    // Many events use status:"primary". Some omit it.
    // We'll only exclude clearly non-primary values.
    const status = normalize(s.status);
    if (status && status !== "primary") continue;

    // ✅ KEY FIX: Some templates store DPS bucket in className (Melee/Ranged)
    // roleName may be blank. So use roleName OR className.
    const bucket = normalize(s.roleName || s.className);

    bucketHistogram.set(bucket || "(blank)", (bucketHistogram.get(bucket || "(blank)") || 0) + 1);

    // Tanks
    if (bucket.includes("tank")) {
      counts.tanks++;
      continue;
    }

    // Healers
    if (bucket.includes("heal")) {
      counts.healers++;
      const spec = String(s.specName || "");
      if (CONFIG.meleeHealerSpecs.has(spec)) counts.mh++;
      else counts.rh++;
      continue;
    }

    // DPS split
    if (bucket.includes("melee")) {
      counts.melee++;
      continue;
    }

    if (bucket.includes("ranged")) {
      counts.ranged++;
      continue;
    }

    // Catch-all for templates that just use "DPS" or "Damage"
    if (bucket === "dps" || bucket.includes("damage")) {
      // Count it as ranged so total DPS isn't lost (optional choice)
      counts.ranged++;
      continue;
    }
  }

  if (teamNameForLogs) {
    const top = Array.from(bucketHistogram.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(`[${teamNameForLogs}] buckets seen: ${top}`);
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

function needCount(have, target) {
  return Math.max(0, target - have);
}

function roleBadge(need) {
  return need === 0 ? ":white_check_mark:" : String(need);
}

// Your style uses :heart: for “all welcome / no cap”
function dpsBadges(dpsNeedTotal) {
  if (dpsNeedTotal <= 0) return { ranged: ":heart:", melee: ":heart:" };
  if (dpsNeedTotal === 1) return { ranged: "1", melee: "1" };
  if (dpsNeedTotal === 2) return { ranged: "1-2", melee: "1-2" };
  return { ranged: "3+", melee: "3+" };
}

function renderRecruitmentPost(teamSummaries) {
  const lines = [];

  lines.push(":clipboard: **Recruitment Key**  ");
  lines.push("- The number shown next to each role = how many positions are needed.");
  lines.push("- :white_check_mark: = All positions for that role are filled.  ");
  lines.push("- 1 (or other number) = That many spots are open.  ");
  lines.push("- :heart: = All are welcome for that role (no cap).");
  lines.push("");
  lines.push("");

  const byName = new Map(teamSummaries.map((s) => [s.teamName.toUpperCase(), s]));

  for (const team of CONFIG.teams) {
    const card = CONFIG.recruitmentCards[team.key];
    if (!card) continue;

    const summary = byName.get(team.name.toUpperCase());

    if (!summary) {
      lines.push(`**${card.headerEmoji} ${team.name}**  `);
      lines.push(`:alarm_clock: ${card.time}  `);
      lines.push(`Raid Leader: ${card.leader}  `);
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

    lines.push(`**${card.headerEmoji} ${team.name}**  `);
    lines.push(`:alarm_clock: ${card.time}  `);
    lines.push(`Raid Leader: ${card.leader}  `);
    lines.push(`- :shield: Tank:  ${roleBadge(tankNeed)}`);
    lines.push(`- :sparkles: Healer:  ${roleBadge(healNeed)}`);
    lines.push(`- :dart: Ranged DPS:  ${dps.ranged}`);
    lines.push(`- :crossed_swords: Melee DPS:  ${dps.melee}`);

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
  const weekOf = now.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

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

// -------------------- Message helpers --------------------

async function ensureBotMessage(textChannel, existingMessageId, label) {
  if (existingMessageId && existingMessageId.trim().length > 0) {
    try {
      return await textChannel.messages.fetch(existingMessageId.trim());
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
      const counts = countRoles(eventJson, team.name);

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

  // Recruitment Thread
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
