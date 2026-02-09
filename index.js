import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

const CONFIG = {
  guildId: process.env.GUILD_ID,
  dashboardChannelId: process.env.DASHBOARD_CHANNEL_ID,
  dashboardMessageId: process.env.DASHBOARD_MESSAGE_ID,

  lookbackMessages: 50, // how many messages to scan in each signup channel

  teams: [
    { name: "SOLOMONO", signupChannelId: "1071192840408940626", raidSize: 20 },
    { name: "CRIT HAPPENS", signupChannelId: "1248666830810251354", raidSize: 20 },
    { name: "EARLY BIRD SPECIAL", signupChannelId: "1216844831767396544", raidSize: 20 },
    { name: "WEEKEND WARRIORS", signupChannelId: "1338703521138081902", raidSize: 20 },
  ],

  targets: { tanks: 2, healers: 4 },
  // Optional: if you want to split healers by spec later
  meleeHealerSpecs: new Set(["Mistweaver", "Holy1", "Holy"]),
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function extractEventIdFromMessage(msg) {
  // 1) Direct link in message content
  const m1 = msg.content?.match(/raid-helper\.dev\/event\/(\d+)/i);
  if (m1) return m1[1];

  // 2) Link inside embeds
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
    throw new Error(`Raid-Helper fetch failed: ${res.status} ${await res.text()}`);
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

    const raidSize = s.raidSize;
    const tanksTarget = CONFIG.targets.tanks;
    const healsTarget = CONFIG.targets.healers;
    const dpsTarget = Math.max(0, raidSize - (tanksTarget + healsTarget));
    const dpsHave = s.counts.melee + s.counts.ranged;

    lines.push(`${s.teamName} (${when})`);
    lines.push(needLine("Tank", s.counts.tanks, tanksTarget));
    lines.push(
      needLine("Heals", s.counts.healers, healsTarget) +
        `  [Melee ${s.counts.mh} | R
