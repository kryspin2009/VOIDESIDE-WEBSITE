const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env.local") });
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "tiers.json");
const DISCORD_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || "").trim();
const DISCORD_SOURCE_CHANNEL_ID = String(process.env.DISCORD_SOURCE_CHANNEL_ID || "").trim();
const DISCORD_SOURCE_CHANNEL_IDS = new Set(parseEnvList(
  process.env.DISCORD_SOURCE_CHANNEL_IDS,
  DISCORD_SOURCE_CHANNEL_ID ? [DISCORD_SOURCE_CHANNEL_ID] : []
));
const DISCORD_SOURCE_GUILD_IDS = new Set(parseEnvList(process.env.DISCORD_SOURCE_GUILD_IDS));
const DISCORD_SOURCE_BOT_ID = String(process.env.DISCORD_SOURCE_BOT_ID || "").trim();
const DISCORD_SOURCE_BOT_IDS = new Set(parseEnvList(
  process.env.DISCORD_SOURCE_BOT_IDS,
  DISCORD_SOURCE_BOT_ID ? [DISCORD_SOURCE_BOT_ID] : []
));
const DISCORD_RESULT_PREFIX = String(process.env.DISCORD_RESULT_PREFIX || "").trim();
const DISCORD_ACCEPT_BOT_MESSAGES = String(process.env.DISCORD_ACCEPT_BOT_MESSAGES || "true").toLowerCase() !== "false";
const DISCORD_ACCEPT_HUMAN_MESSAGES = String(process.env.DISCORD_ACCEPT_HUMAN_MESSAGES || "false").toLowerCase() === "true";
const TIERS_CORS_ORIGINS = new Set(
  parseEnvList(process.env.TIERS_CORS_ORIGINS)
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean)
);

const OVERALL_TIERS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
const LEGACY_OVERALL_TIERS = ["ht1", "lt1", "ht2", "lt2", "ht3", "lt3", "ht4", "lt4", "ht5", "lt5"];
const DSM_TIERS = ["tier-1", "tier-2", "tier-3", "tier-4", "tier-5"];
const TIER_POINTS = {
  HT1: 60,
  LT1: 45,
  HT2: 30,
  LT2: 20,
  HT3: 10,
  LT3: 6,
  HT4: 4,
  LT4: 3,
  HT5: 2,
  LT5: 1
};

let discordWriteQueue = Promise.resolve();

app.use("/api", (req, res, next) => {
  applyApiCors(req, res);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  return next();
});
app.use(express.json({ limit: "256kb" }));
app.use(express.static(__dirname));

function parseEnvList(value, fallback = []) {
  const seed = Array.isArray(fallback) ? fallback : [];
  const raw = String(value || "")
    .split(/[\r\n,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);

  return raw.length ? raw : seed;
}

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/g, "");
}

function isCorsOriginAllowed(origin) {
  if (!origin) {
    return false;
  }

  if (TIERS_CORS_ORIGINS.has("*")) {
    return true;
  }

  return TIERS_CORS_ORIGINS.has(normalizeOrigin(origin));
}

function applyApiCors(req, res) {
  const origin = normalizeOrigin(req.get("origin"));
  if (!isCorsOriginAllowed(origin)) {
    return;
  }

  res.append("Vary", "Origin");
  res.set("Access-Control-Allow-Origin", TIERS_CORS_ORIGINS.has("*") ? "*" : origin);
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Tier-Secret");
}

function emptyState() {
  return {
    overall: Object.fromEntries(OVERALL_TIERS.map((tier) => [tier, null])),
    dsm: Object.fromEntries(DSM_TIERS.map((tier) => [tier, []])),
    updatedAt: new Date().toISOString()
  };
}

function normalizeUsername(value) {
  return String(value || "").trim();
}

function parseKnownRegion(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw || /^N\s*\/\s*A$/.test(raw) || /^(?:UNKNOWN|NONE|NULL|UNSET)$/.test(raw)) {
    return null;
  }

  const compact = raw.replace(/[^A-Z]/g, "");
  if (!compact) {
    return null;
  }

  if (compact === "EU" || compact === "EUROPE") {
    return "EU";
  }

  if (compact === "NA" || compact === "NORTHAMERICA" || compact === "NORTHAMERICAN") {
    return "NA";
  }

  if (compact === "AU" || compact === "AUS" || compact === "AUSTRALIA" || compact === "OCE" || compact === "OCEANIA") {
    return "AU";
  }

  if (compact === "AS" || compact === "ASIA" || compact === "ASIAN") {
    return "AS";
  }

  return null;
}

function normalizeRegion(value, fallback = null) {
  return parseKnownRegion(value) || fallback;
}

function normalizeOverallTierTag(value) {
  const token = String(value || "").trim().toUpperCase();
  return /^(?:HT|LT)[1-5]$/.test(token) ? token : null;
}

function normalizeTags(value, fallbackTag) {
  const rawTags = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,|/]+/g).filter(Boolean)
      : [];
  const cleaned = rawTags
    .map((tag) => normalizeOverallTierTag(tag))
    .filter(Boolean);
  if (cleaned.length) {
    return cleaned;
  }

  const safeFallbackTag = normalizeOverallTierTag(fallbackTag);
  return safeFallbackTag ? [safeFallbackTag] : [];
}

function calculateOverallPoints(tags, fallbackTag = null) {
  return normalizeTags(tags, fallbackTag).reduce((total, tag) => total + (TIER_POINTS[tag] || 0), 0);
}

function parseOverallTierInput(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return null;
  }

  const compact = raw.replace(/[\s_-]+/g, "");
  if (OVERALL_TIERS.includes(compact)) {
    return { rank: compact, fallbackTag: null };
  }

  const rankMatch = compact.match(/^rank(10|[1-9])$/);
  if (rankMatch && OVERALL_TIERS.includes(rankMatch[1])) {
    return { rank: rankMatch[1], fallbackTag: null };
  }

  const legacyIndex = LEGACY_OVERALL_TIERS.indexOf(compact);
  if (legacyIndex !== -1) {
    return {
      rank: OVERALL_TIERS[legacyIndex],
      fallbackTag: compact.toUpperCase()
    };
  }

  return null;
}

function getOverallEntries(state) {
  return OVERALL_TIERS
    .map((rankKey) => sanitizeOverallEntry(state?.overall?.[rankKey], null))
    .filter(Boolean);
}

function writeOverallEntriesByPoints(state, entries) {
  const byUsername = new Map();

  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    const safeEntry = sanitizeOverallEntry(entry, null);
    if (!safeEntry) {
      return;
    }

    const key = safeEntry.username.toLowerCase();
    if (!byUsername.has(key)) {
      byUsername.set(key, { ...safeEntry, _order: index });
      return;
    }

    const existing = byUsername.get(key);
    byUsername.set(key, {
      ...existing,
      region: safeEntry.region || existing.region,
      tags: [...normalizeTags(existing.tags, null), ...normalizeTags(safeEntry.tags, null)],
      _order: Math.min(existing._order, index)
    });
  });

  const sorted = Array.from(byUsername.values())
    .sort((a, b) => {
      const pointsDiff = calculateOverallPoints(b.tags, null) - calculateOverallPoints(a.tags, null);
      if (pointsDiff !== 0) {
        return pointsDiff;
      }

      const nameDiff = a.username.localeCompare(b.username, undefined, { sensitivity: "base" });
      if (nameDiff !== 0) {
        return nameDiff;
      }

      return a._order - b._order;
    })
    .slice(0, OVERALL_TIERS.length)
    .map(({ _order, ...entry }) => entry);

  OVERALL_TIERS.forEach((rankKey, index) => {
    state.overall[rankKey] = sorted[index] || null;
  });
}

function sanitizeOverallEntry(input, fallbackTag) {
  const safeFallbackTag = normalizeOverallTierTag(fallbackTag);

  if (input == null) {
    return null;
  }

  if (typeof input === "string") {
    const username = normalizeUsername(input);
    if (!username || !safeFallbackTag) {
      return null;
    }

    return {
      username,
      region: null,
      tags: [safeFallbackTag]
    };
  }

  if (typeof input !== "object") {
    return null;
  }

  const username = normalizeUsername(input.username);
  if (!username) {
    return null;
  }

  const tags = normalizeTags(input.tags, safeFallbackTag);
  if (!tags.length) {
    return null;
  }

  return {
    username,
    region: normalizeRegion(input.region),
    tags
  };
}

function sanitizeDsmEntry(input) {
  if (input == null) {
    return null;
  }

  if (typeof input === "string") {
    const username = normalizeUsername(input);
    if (!username) {
      return null;
    }

    return {
      username,
      highTier: false
    };
  }

  if (typeof input !== "object") {
    return null;
  }

  const username = normalizeUsername(input.username);
  if (!username) {
    return null;
  }

  const safeEntry = {
    username,
    highTier: typeof input.highTier === "boolean" ? input.highTier : false
  };

  const region = parseKnownRegion(input.region);
  if (region) {
    safeEntry.region = region;
  }

  return safeEntry;
}

function extractMinecraftUsername(value) {
  const text = String(value || "");
  const match = text.match(/[A-Za-z0-9_]{1,16}/);
  return match ? match[0] : "";
}

function extractRegionFromText(value) {
  const text = String(value || "");
  if (!text.trim()) {
    return null;
  }

  const exactRegion = parseKnownRegion(text);
  if (exactRegion) {
    return exactRegion;
  }

  if (/\b(?:EU|EUROPE)\b/i.test(text)) {
    return "EU";
  }

  if (/\b(?:NA|NORTH\s*AMERICA(?:N)?)\b/i.test(text)) {
    return "NA";
  }

  if (/\b(?:AUSTRALIA|OCEANIA|OCE)\b/i.test(text)) {
    return "AU";
  }

  if (/\bASIA(?:N)?\b/i.test(text)) {
    return "AS";
  }

  return null;
}

function stripRegionFromText(value) {
  return String(value || "")
    .replace(/\bN\s*\/\s*A\b/gi, " ")
    .replace(/\bEUROPE\b/gi, " ")
    .replace(/\bEU\b/gi, " ")
    .replace(/\bNORTH\s*AMERICA(?:N)?\b/gi, " ")
    .replace(/\bNA\b/gi, " ")
    .replace(/\bAUSTRALIA\b/gi, " ")
    .replace(/\bOCEANIA\b/gi, " ")
    .replace(/\bOCE\b/gi, " ")
    .replace(/\bASIA(?:N)?\b/gi, " ");
}

function isLikelyRegionToken(value) {
  const token = String(value || "").trim().toLowerCase();
  return Boolean(parseKnownRegion(token)) || ["as", "asia", "asian", "sa", "oce", "oceania", "au", "aus", "australia", "af"].includes(token);
}

function isDiscordMentionToken(value) {
  const token = String(value || "").trim();
  return /^<@!?\d+>$/.test(token) || token.startsWith("@");
}

function parseDsmTierInput(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return null;
  }

  // Normalize separators so formats like "HT 1", "high-tier-1", "tier_3" work.
  const compact = raw.replace(/[\s_-]+/g, "");

  const highMatch =
    compact.match(/^(?:h|ht|high|hightier|htier)([1-5])$/) ||
    compact.match(/^([1-5])(?:h|ht|high)$/);
  if (highMatch) {
    return {
      tier: `tier-${highMatch[1]}`,
      inferredHighTier: true
    };
  }

  const lowMatch =
    compact.match(/^(?:l|lt|low|lowtier|ltier)([1-5])$/) ||
    compact.match(/^([1-5])(?:l|lt|low)$/);
  if (lowMatch) {
    return {
      tier: `tier-${lowMatch[1]}`,
      inferredHighTier: false
    };
  }

  const genericMatch = compact.match(/^(?:tier)?([1-5])$/);
  if (genericMatch) {
    return {
      tier: `tier-${genericMatch[1]}`,
      inferredHighTier: false
    };
  }

  if (DSM_TIERS.includes(raw)) {
    return {
      tier: raw,
      inferredHighTier: false
    };
  }

  return null;
}

function parseDsmLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return null;
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].replace(/[.,;:!?]+$/g, "");
    const parsedTier = parseDsmTierInput(token);
    if (!parsedTier) {
      continue;
    }

    const remainingText = tokens
      .filter((_, current) => current !== index && !isDiscordMentionToken(tokens[current]))
      .join(" ");
    const regionInput = extractRegionFromText(remainingText);
    const usernameText = stripRegionFromText(remainingText);
    const username = extractMinecraftUsername(usernameText);
    if (!username) {
      return null;
    }

    return {
      tierInput: token,
      usernameInput: username,
      regionInput
    };
  }

  return null;
}

function extractTierInputFromText(text, preferLast = false) {
  const compactTokens = String(text || "")
    .replace(/->/g, " ")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (!compactTokens.length) {
    return "";
  }

  const candidates = [];
  for (let index = 0; index < compactTokens.length; index += 1) {
    const one = compactTokens[index];
    const two = index + 1 < compactTokens.length ? `${compactTokens[index]}${compactTokens[index + 1]}` : "";
    const three = index + 2 < compactTokens.length
      ? `${compactTokens[index]}${compactTokens[index + 1]}${compactTokens[index + 2]}`
      : "";

    [one, two, three].forEach((token) => {
      if (!token) {
        return;
      }
      if (parseDsmTierInput(token)) {
        candidates.push(token);
      }
    });
  }

  if (!candidates.length) {
    return "";
  }

  return preferLast ? candidates[candidates.length - 1] : candidates[0];
}

function extractUsernameFromEmbedDescription(description) {
  const parts = String(description || "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    const middle = parts[1];
    const middleName = extractMinecraftUsername(middle);
    if (middleName) {
      return middleName;
    }
  }

  for (const part of parts) {
    if (isDiscordMentionToken(part) || isLikelyRegionToken(part) || extractRegionFromText(part)) {
      continue;
    }
    const username = extractMinecraftUsername(part);
    if (username) {
      return username;
    }
  }

  return "";
}

function extractRegionFromEmbedDescription(description) {
  const parts = String(description || "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    const region = extractRegionFromText(part);
    if (region) {
      return region;
    }
  }

  return null;
}

function extractRegionFromEmbedFields(fields) {
  const safeFields = Array.isArray(fields) ? fields : [];
  for (const field of safeFields) {
    const fromName = extractRegionFromText(String(field?.name || ""));
    if (fromName) {
      return fromName;
    }

    const fromValue = extractRegionFromText(String(field?.value || ""));
    if (fromValue) {
      return fromValue;
    }
  }

  return null;
}

function parseDsmResultFromEmbed(embed) {
  if (!embed) {
    return null;
  }

  const title = String(embed.title || "");
  const description = String(embed.description || "");
  const fields = Array.isArray(embed.fields) ? embed.fields : [];

  // Preferred source for tier from your format: "Result - LT3".
  let tierInput = extractTierInputFromText(title, false);

  // Fallback: use target tier from rank transition, e.g. "LT4 -> LT3".
  if (!tierInput) {
    const rankField = fields.find((field) => /rank|result|tier/i.test(String(field?.name || "")));
    if (rankField) {
      tierInput = extractTierInputFromText(String(rankField.value || ""), true);
    }
  }

  if (!tierInput) {
    tierInput = extractTierInputFromText(description, true);
  }

  // Preferred source for username from your format: "@x | username | region".
  let usernameInput = extractUsernameFromEmbedDescription(description);
  let regionInput = extractRegionFromEmbedDescription(description);

  if (!regionInput) {
    regionInput = extractRegionFromEmbedFields(fields);
  }

  if (!regionInput) {
    regionInput = extractRegionFromText(title);
  }

  if (!usernameInput) {
    const userField = fields.find((field) => /user|username|player|ign|tester/i.test(String(field?.name || "")));
    if (userField) {
      usernameInput = extractMinecraftUsername(String(userField.value || ""));
    }
  }

  if (!tierInput || !usernameInput) {
    return null;
  }

  return { tierInput, usernameInput, regionInput };
}

function parseDsmResultsFromContent(content) {
  const lines = String(content || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return [];
  }

  const results = [];
  const prefixLower = DISCORD_RESULT_PREFIX.toLowerCase();

  lines.forEach((line) => {
    if (DISCORD_RESULT_PREFIX) {
      if (!line.toLowerCase().startsWith(prefixLower)) {
        return;
      }
    }

    const rowText = DISCORD_RESULT_PREFIX ? line.slice(DISCORD_RESULT_PREFIX.length).trim() : line;
    const parsed = parseDsmLine(rowText);
    if (parsed) {
      results.push(parsed);
    }
  });

  return results;
}

function dedupeDsmResults(results) {
  const seen = new Set();
  const unique = [];

  results.forEach((row) => {
    const key = `${String(row?.tierInput || "").toLowerCase()}|${String(row?.usernameInput || "").toLowerCase()}`;
    if (!row || !row.tierInput || !row.usernameInput || seen.has(key)) {
      return;
    }
    seen.add(key);
    unique.push(row);
  });

  return unique;
}

function parseDsmResultsFromMessage(message) {
  const fromContent = parseDsmResultsFromContent(message?.content || "");
  const fromEmbeds = Array.isArray(message?.embeds)
    ? message.embeds
      .map((embed) => parseDsmResultFromEmbed(embed))
      .filter(Boolean)
    : [];

  return dedupeDsmResults([...fromEmbeds, ...fromContent]);
}

function removeDsmUserEverywhere(state, username) {
  const needle = username.toLowerCase();
  DSM_TIERS.forEach((tierKey) => {
    const list = Array.isArray(state.dsm[tierKey]) ? state.dsm[tierKey] : [];
    state.dsm[tierKey] = list.filter((entry) => entry.username.toLowerCase() !== needle);
  });
}

function getDsmRegionByUsername(state, username) {
  const needle = normalizeUsername(username).toLowerCase();
  if (!needle) {
    return null;
  }

  for (const tierKey of DSM_TIERS) {
    const list = Array.isArray(state?.dsm?.[tierKey]) ? state.dsm[tierKey] : [];
    const match = list.find((entry) => String(entry?.username || "").toLowerCase() === needle);
    const region = parseKnownRegion(match?.region);
    if (region) {
      return region;
    }
  }

  return null;
}

function getOverallRegionByUsername(state, username) {
  const rankKey = getOverallRankByUsername(state, username);
  return rankKey ? parseKnownRegion(state?.overall?.[rankKey]?.region) : null;
}

function addOrMoveDsmUser(state, { tierInput, usernameInput, highTierInput, positionInput, regionInput }) {
  const parsedTier = parseDsmTierInput(tierInput);
  if (!parsedTier) {
    return { error: "Invalid DSM tier. Use HT1/LT1..HT5/LT5 or tier-1..tier-5" };
  }

  const username = normalizeUsername(usernameInput);
  if (!username) {
    return { error: "username is required" };
  }

  const storedRegion = getDsmRegionByUsername(state, username) || getOverallRegionByUsername(state, username);
  removeDsmUserEverywhere(state, username);

  const targetTier = parsedTier.tier;
  const targetList = Array.isArray(state.dsm[targetTier]) ? state.dsm[targetTier] : [];
  const highTier = typeof highTierInput === "boolean" ? highTierInput : Boolean(parsedTier.inferredHighTier);
  const incoming = sanitizeDsmEntry({
    username,
    highTier,
    region: parseKnownRegion(regionInput) || storedRegion
  });
  const position = Number.isInteger(positionInput) ? positionInput : null;

  if (position != null && position >= 0 && position <= targetList.length) {
    targetList.splice(position, 0, incoming);
  } else {
    targetList.push(incoming);
  }

  state.dsm[targetTier] = targetList;
  return {
    tier: targetTier,
    value: incoming
  };
}

function getOverallRankByUsername(state, username) {
  const needle = normalizeUsername(username).toLowerCase();
  if (!needle) {
    return null;
  }

  return OVERALL_TIERS.find((rankKey) => {
    const entry = state.overall[rankKey];
    return entry && String(entry.username || "").toLowerCase() === needle;
  }) || null;
}

function mapDsmToOverallTag(dsmTierKey, highTier) {
  const tierNumber = String(dsmTierKey || "").split("-")[1];
  if (!tierNumber || !/^[1-5]$/.test(tierNumber)) {
    return null;
  }

  return `${highTier ? "HT" : "LT"}${tierNumber}`;
}

function rebuildOverallFromDsm(state, regionHints) {
  const hintMap = regionHints instanceof Map ? regionHints : new Map();
  const existingRegionByUser = new Map(
    getOverallEntries(state).map((entry) => [entry.username.toLowerCase(), normalizeRegion(entry.region)])
  );
  const overallEntries = [];

  DSM_TIERS.forEach((tierKey) => {
    const list = Array.isArray(state.dsm[tierKey]) ? state.dsm[tierKey] : [];
    list.forEach((rawEntry) => {
      const entry = sanitizeDsmEntry(rawEntry);
      if (!entry) {
        return;
      }

      const tag = mapDsmToOverallTag(tierKey, Boolean(entry.highTier));
      if (!tag) {
        return;
      }

      const key = entry.username.toLowerCase();
      const region =
        parseKnownRegion(entry.region) ||
        hintMap.get(key) ||
        existingRegionByUser.get(key) ||
        null;

      if (rawEntry && typeof rawEntry === "object" && !parseKnownRegion(rawEntry.region)) {
        rawEntry.region = region;
      }

      const overallEntry = sanitizeOverallEntry(
        {
          username: entry.username,
          region,
          tags: [tag]
        },
        tag
      );

      if (overallEntry) {
        overallEntries.push(overallEntry);
      }
    });
  });

  writeOverallEntriesByPoints(state, overallEntries);
}

async function applyDiscordDsmResults(results, sourceLabel) {
  discordWriteQueue = discordWriteQueue.then(async () => {
    const state = await readState();
    const applied = [];
    const rejected = [];
    const regionHints = new Map();

    results.forEach((row, index) => {
      const addResult = addOrMoveDsmUser(state, row);
      if (addResult.error) {
        rejected.push({ index, error: addResult.error });
        return;
      }
      const region = parseKnownRegion(row?.regionInput);
      if (region) {
        regionHints.set(addResult.value.username.toLowerCase(), region);
      }

      applied.push({
        index,
        tier: addResult.tier,
        overallTier: null,
        username: addResult.value.username,
        highTier: addResult.value.highTier
      });
    });

    if (!applied.length) {
      if (rejected.length) {
        console.warn(`[discord] Rejected all ${rejected.length} result(s) from ${sourceLabel}`);
      }
      return;
    }

    rebuildOverallFromDsm(state, regionHints);
    applied.forEach((entry) => {
      entry.overallTier = getOverallRankByUsername(state, entry.username);
    });

    await writeState(state);
    console.log(`[discord] Applied ${applied.length} DSM result(s) from ${sourceLabel}`);
    if (rejected.length) {
      console.warn(`[discord] Rejected ${rejected.length} DSM result(s) from ${sourceLabel}`);
    }
  }).catch((error) => {
    console.error("[discord] Failed to apply DSM results:", error);
  });

  return discordWriteQueue;
}

function logDiscordIntentHelp(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (!message.includes("disallowed intents")) {
    return;
  }

  console.error("[discord] Enable Message Content Intent in Discord Developer Portal:");
  console.error("[discord] 1) https://discord.com/developers/applications");
  console.error("[discord] 2) Open your app -> Bot -> Privileged Gateway Intents");
  console.error("[discord] 3) Turn ON 'Message Content Intent' and save");
  console.error("[discord] 4) Restart this server");
}

function isAllowedDiscordSource(message) {
  if (!message || !message.channelId) {
    return false;
  }

  const matchesChannel = DISCORD_SOURCE_CHANNEL_IDS.size
    ? DISCORD_SOURCE_CHANNEL_IDS.has(message.channelId)
    : false;
  const matchesGuild = DISCORD_SOURCE_GUILD_IDS.size
    ? Boolean(message.guildId) && DISCORD_SOURCE_GUILD_IDS.has(message.guildId)
    : false;

  return matchesChannel || matchesGuild;
}

function startDiscordBridge() {
  if (!DISCORD_BOT_TOKEN || (!DISCORD_SOURCE_CHANNEL_IDS.size && !DISCORD_SOURCE_GUILD_IDS.size)) {
    console.log("[discord] Bridge disabled (set DISCORD_BOT_TOKEN and at least one source channel or guild to enable).");
    return;
  }

  let Client;
  let GatewayIntentBits;
  try {
    ({ Client, GatewayIntentBits } = require("discord.js"));
  } catch (error) {
    console.warn("[discord] Bridge disabled because discord.js is not installed.");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  client.once("clientReady", () => {
    const tag = client.user ? client.user.tag : "unknown";
    const targets = [];
    if (DISCORD_SOURCE_CHANNEL_IDS.size) {
      targets.push(`channels ${Array.from(DISCORD_SOURCE_CHANNEL_IDS).join(", ")}`);
    }
    if (DISCORD_SOURCE_GUILD_IDS.size) {
      targets.push(`guilds ${Array.from(DISCORD_SOURCE_GUILD_IDS).join(", ")}`);
    }
    console.log(`[discord] Logged in as ${tag}. Watching ${targets.join(" | ")}`);
  });

  client.on("messageCreate", async (message) => {
    if (!isAllowedDiscordSource(message)) {
      return;
    }

    if (DISCORD_SOURCE_BOT_IDS.size && !DISCORD_SOURCE_BOT_IDS.has(String(message.author?.id || ""))) {
      return;
    }

    if (message.author.bot && !DISCORD_ACCEPT_BOT_MESSAGES) {
      return;
    }

    if (!message.author.bot && !DISCORD_ACCEPT_HUMAN_MESSAGES) {
      return;
    }

    const parsedResults = parseDsmResultsFromMessage(message);
    if (!parsedResults.length) {
      return;
    }

    await applyDiscordDsmResults(parsedResults, `Discord message ${message.id}`);
  });

  client.login(DISCORD_BOT_TOKEN).catch((error) => {
    console.error("[discord] Login failed:", error);
    logDiscordIntentHelp(error);
  });
}

function sanitizeState(raw) {
  const state = emptyState();

  if (raw && typeof raw === "object" && raw.overall && typeof raw.overall === "object") {
    const migratedOverallEntries = [];

    Object.entries(raw.overall).forEach(([slot, entry]) => {
      const parsed = parseOverallTierInput(slot);
      if (!parsed) {
        return;
      }

      const safeEntry = sanitizeOverallEntry(entry, parsed.fallbackTag);
      if (safeEntry) {
        migratedOverallEntries.push(safeEntry);
      }
    });

    writeOverallEntriesByPoints(state, migratedOverallEntries);
  }

  if (raw && typeof raw === "object" && raw.dsm && typeof raw.dsm === "object") {
    DSM_TIERS.forEach((tier) => {
      const list = Array.isArray(raw.dsm[tier]) ? raw.dsm[tier] : [];
      state.dsm[tier] = list.map((entry) => sanitizeDsmEntry(entry)).filter(Boolean);
    });
  }

  if (DSM_TIERS.some((tier) => Array.isArray(state.dsm[tier]) && state.dsm[tier].length)) {
    rebuildOverallFromDsm(state);
  }

  state.updatedAt =
    raw && typeof raw === "object" && typeof raw.updatedAt === "string"
      ? raw.updatedAt
      : new Date().toISOString();

  return state;
}

async function readState() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return sanitizeState(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    const initial = emptyState();
    await writeState(initial);
    return initial;
  }
}

async function writeState(state) {
  state.updatedAt = new Date().toISOString();
  await fs.writeFile(DATA_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function applyBulkSyncPayload(state, body) {
  if (body?.overall && typeof body.overall === "object") {
    const stagedOverall = Object.fromEntries(
      OVERALL_TIERS.map((rankKey) => [rankKey, sanitizeOverallEntry(state.overall[rankKey], null)])
    );

    Object.entries(body.overall).forEach(([slot, value]) => {
      const parsed = parseOverallTierInput(slot);
      if (!parsed) {
        return;
      }

      stagedOverall[parsed.rank] = sanitizeOverallEntry(value, parsed.fallbackTag);
    });

    writeOverallEntriesByPoints(state, Object.values(stagedOverall).filter(Boolean));
  }

  if (body?.dsm && typeof body.dsm === "object") {
    DSM_TIERS.forEach((tier) => {
      if (Object.prototype.hasOwnProperty.call(body.dsm, tier)) {
        const nextList = Array.isArray(body.dsm[tier]) ? body.dsm[tier] : [];
        state.dsm[tier] = nextList.map((entry) => sanitizeDsmEntry(entry)).filter(Boolean);
      }
    });

    rebuildOverallFromDsm(state);
  }
}

function applyDsmResultsPayload(state, results, { replace = false } = {}) {
  const safeResults = Array.isArray(results) ? results : [];
  if (!safeResults.length) {
    return { error: "results array is required", status: 400 };
  }

  if (replace) {
    DSM_TIERS.forEach((tierKey) => {
      state.dsm[tierKey] = [];
    });
  }

  const applied = [];
  const rejected = [];

  safeResults.forEach((row, index) => {
    const addResult = addOrMoveDsmUser(state, {
      tierInput: row?.tier,
      usernameInput: row?.username,
      highTierInput: row?.highTier,
      positionInput: row?.position,
      regionInput: row?.region
    });

    if (addResult.error) {
      rejected.push({ index, error: addResult.error });
      return;
    }

    applied.push({
      index,
      tier: addResult.tier,
      username: addResult.value.username,
      highTier: addResult.value.highTier
    });
  });

  if (!applied.length) {
    return { error: "No valid DSM results to apply", rejected, status: 400 };
  }

  rebuildOverallFromDsm(state);
  applied.forEach((entry) => {
    entry.overallTier = getOverallRankByUsername(state, entry.username);
  });

  return {
    ok: true,
    mode: "dsm",
    applied,
    rejected
  };
}

function applySingleTierUpdatePayload(state, body) {
  const mode = String(body?.mode || "dsm").trim().toLowerCase();
  const tier = String(body?.tier || body?.rank || "").trim();
  const op = String(body?.op || "set").trim().toLowerCase();

  if (mode === "overall") {
    const parsedTier = parseOverallTierInput(tier);
    if (!parsedTier) {
      return { error: `Invalid overall tier '${tier}'. Use 1-10 (or rank1-rank10).`, status: 400 };
    }

    const explicitTagInput = body?.tags ?? body?.tag ?? body?.tierTag ?? body?.overallTag ?? null;
    const explicitFallbackTag = normalizeOverallTierTag(explicitTagInput);
    const effectiveFallbackTag = explicitFallbackTag || parsedTier.fallbackTag;
    const targetRank = parsedTier.rank;

    if (op === "clear") {
      state.overall[targetRank] = null;
      writeOverallEntriesByPoints(state, getOverallEntries(state));
    } else {
      const entry = sanitizeOverallEntry(
        {
          username: body?.username,
          region: body?.region,
          tags: explicitTagInput
        },
        effectiveFallbackTag
      );

      if (!entry) {
        return { error: "username and at least one tier tag (HT1-LT5) are required for overall set", status: 400 };
      }

      const nextEntries = getOverallEntries(state).filter(
        (current) => current.username.toLowerCase() !== entry.username.toLowerCase()
      );
      nextEntries.push(entry);
      writeOverallEntriesByPoints(state, nextEntries);
    }

    const resolvedRank =
      op === "clear"
        ? targetRank
        : OVERALL_TIERS.find((rankKey) => {
          const current = state.overall[rankKey];
          return current && String(current.username || "").toLowerCase() === String(body?.username || "").toLowerCase();
        }) || null;

    return {
      ok: true,
      mode,
      tier: targetRank,
      resolvedRank,
      value: resolvedRank ? state.overall[resolvedRank] : state.overall[targetRank]
    };
  }

  if (mode !== "dsm") {
    return { error: `Invalid mode '${mode}', use 'overall' or 'dsm'`, status: 400 };
  }

  const username = normalizeUsername(body?.username);
  const parsedTier = parseDsmTierInput(tier);

  if (op === "clear") {
    if (!parsedTier) {
      return { error: `Invalid DSM tier '${tier}'`, status: 400 };
    }

    state.dsm[parsedTier.tier] = [];
    rebuildOverallFromDsm(state);
    return { ok: true, mode, tier: parsedTier.tier, value: [] };
  }

  if (op === "remove") {
    if (!username) {
      return { error: "username is required for dsm remove", status: 400 };
    }

    removeDsmUserEverywhere(state, username);
    rebuildOverallFromDsm(state);
    return {
      ok: true,
      mode,
      tier: parsedTier ? parsedTier.tier : null,
      removed: username,
      overallTier: getOverallRankByUsername(state, username)
    };
  }

  const addResult = addOrMoveDsmUser(state, {
    tierInput: tier,
    usernameInput: body?.username,
    highTierInput: body?.highTier,
    positionInput: body?.position,
    regionInput: body?.region
  });

  if (addResult.error) {
    return { error: addResult.error, status: 400 };
  }

  rebuildOverallFromDsm(state);
  const overallTier = getOverallRankByUsername(state, addResult.value.username);
  return {
    ok: true,
    mode,
    tier: addResult.tier,
    overallTier,
    player: addResult.value,
    value: state.dsm[addResult.tier]
  };
}

function applyWebhookPayload(state, body) {
  const safeBody = body && typeof body === "object" ? body : {};

  if (safeBody.overall || safeBody.dsm) {
    applyBulkSyncPayload(state, safeBody);
    return { ok: true, mode: "bulk" };
  }

  const groupedResults = Array.isArray(safeBody.results)
    ? safeBody.results
    : Array.isArray(safeBody.players)
      ? safeBody.players
      : Array.isArray(safeBody.entries)
        ? safeBody.entries
        : null;

  if (groupedResults) {
    return applyDsmResultsPayload(state, groupedResults, { replace: Boolean(safeBody.replace) });
  }

  return applySingleTierUpdatePayload(state, safeBody);
}

function requireSecret(req, res, next) {
  const expected = process.env.TIER_SECRET;
  if (!expected) {
    return res.status(500).json({ error: "TIER_SECRET is not configured on server" });
  }

  const provided = req.get("x-tier-secret") || req.body?.secret;
  if (provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
}

async function handleTiersRead(_req, res) {
  try {
    const state = await readState();
    res.set("Cache-Control", "no-store");
    return res.json(state);
  } catch (error) {
    console.error("GET /api/tiers failed:", error);
    return res.status(500).json({ error: "Failed to read tier data" });
  }
}

async function handleWebhookRoute(req, res, routeLabel) {
  try {
    const state = await readState();
    const result = applyWebhookPayload(state, req.body);
    if (!result.ok) {
      return res.status(result.status || 400).json(result);
    }

    await writeState(state);
    return res.json({
      ...result,
      updatedAt: state.updatedAt
    });
  } catch (error) {
    console.error(`POST ${routeLabel} failed:`, error);
    return res.status(500).json({ error: "Failed to sync tiers" });
  }
}

app.get("/api/tiers", handleTiersRead);
app.get("/tiers", handleTiersRead);

[
  "/api/tiers",
  "/api/webhook",
  "/api/sync",
  "/tiers",
  "/webhook",
  "/sync",
  "/"
].forEach((routePath) => {
  app.post(routePath, requireSecret, async (req, res) => handleWebhookRoute(req, res, routePath));
});

app.post("/api/update-tier", requireSecret, async (req, res) => {
  const mode = String(req.body?.mode || "overall").trim().toLowerCase();
  const tier = String(req.body?.tier || "").trim();
  const op = String(req.body?.op || "set").trim().toLowerCase();

  try {
    const state = await readState();

    if (mode === "overall") {
      const parsedTier = parseOverallTierInput(tier);
      if (!parsedTier) {
        return res.status(400).json({ error: `Invalid overall tier '${tier}'. Use 1-10 (or rank1-rank10).` });
      }

      const explicitTagInput = req.body?.tags ?? req.body?.tag ?? req.body?.tierTag ?? req.body?.overallTag ?? null;
      const explicitFallbackTag = normalizeOverallTierTag(explicitTagInput);
      const effectiveFallbackTag = explicitFallbackTag || parsedTier.fallbackTag;
      const targetRank = parsedTier.rank;
      if (op === "clear") {
        state.overall[targetRank] = null;
        writeOverallEntriesByPoints(state, getOverallEntries(state));
      } else {
        const entry = sanitizeOverallEntry(
          {
            username: req.body?.username,
            region: req.body?.region,
            tags: explicitTagInput
          },
          effectiveFallbackTag
        );

        if (!entry) {
          return res.status(400).json({ error: "username and at least one tier tag (HT1-LT5) are required for overall set" });
        }

        const nextEntries = getOverallEntries(state).filter(
          (current) => current.username.toLowerCase() !== entry.username.toLowerCase()
        );
        nextEntries.push(entry);
        writeOverallEntriesByPoints(state, nextEntries);
      }

      await writeState(state);
      const resolvedRank =
        op === "clear"
          ? targetRank
          : OVERALL_TIERS.find((rankKey) => {
            const current = state.overall[rankKey];
            return current && String(current.username || "").toLowerCase() === String(req.body?.username || "").toLowerCase();
          }) || null;

      return res.json({
        ok: true,
        mode,
        tier: targetRank,
        resolvedRank,
        value: resolvedRank ? state.overall[resolvedRank] : state.overall[targetRank],
        updatedAt: state.updatedAt
      });
    }

    if (mode === "dsm") {
      const username = normalizeUsername(req.body?.username);
      const parsedTier = parseDsmTierInput(tier);

      if (op === "clear") {
        if (!parsedTier) {
          return res.status(400).json({ error: `Invalid DSM tier '${tier}'` });
        }
        state.dsm[parsedTier.tier] = [];
        rebuildOverallFromDsm(state);
        await writeState(state);
        return res.json({ ok: true, mode, tier: parsedTier.tier, value: [], updatedAt: state.updatedAt });
      } else if (op === "remove") {
        if (!username) {
          return res.status(400).json({ error: "username is required for dsm remove" });
        }

        removeDsmUserEverywhere(state, username);
        rebuildOverallFromDsm(state);
        await writeState(state);
        return res.json({
          ok: true,
          mode,
          tier: parsedTier ? parsedTier.tier : null,
          removed: username,
          overallTier: getOverallRankByUsername(state, username),
          updatedAt: state.updatedAt
        });
      } else {
        const addResult = addOrMoveDsmUser(state, {
          tierInput: tier,
          usernameInput: req.body?.username,
          highTierInput: req.body?.highTier,
          positionInput: req.body?.position,
          regionInput: req.body?.region
        });
        if (addResult.error) {
          return res.status(400).json({ error: addResult.error });
        }

        rebuildOverallFromDsm(state);
        const overallTier = getOverallRankByUsername(state, addResult.value.username);
        await writeState(state);
        return res.json({
          ok: true,
          mode,
          tier: addResult.tier,
          overallTier,
          value: state.dsm[addResult.tier],
          updatedAt: state.updatedAt
        });
      }
    }

    return res.status(400).json({ error: `Invalid mode '${mode}', use 'overall' or 'dsm'` });
  } catch (error) {
    console.error("POST /api/update-tier failed:", error);
    return res.status(500).json({ error: "Failed to update tier" });
  }
});

app.post("/api/dsm-result", requireSecret, async (req, res) => {
  try {
    const state = await readState();
    const addResult = addOrMoveDsmUser(state, {
      tierInput: req.body?.tier,
      usernameInput: req.body?.username,
      highTierInput: req.body?.highTier,
      positionInput: req.body?.position,
      regionInput: req.body?.region
    });

    if (addResult.error) {
      return res.status(400).json({ error: addResult.error });
    }

    rebuildOverallFromDsm(state);
    const overallTier = getOverallRankByUsername(state, addResult.value.username);
    await writeState(state);
    return res.json({
      ok: true,
      mode: "dsm",
      tier: addResult.tier,
      overallTier,
      player: addResult.value,
      value: state.dsm[addResult.tier],
      updatedAt: state.updatedAt
    });
  } catch (error) {
    console.error("POST /api/dsm-result failed:", error);
    return res.status(500).json({ error: "Failed to update DSM result" });
  }
});

app.post("/api/dsm-results", requireSecret, async (req, res) => {
  const results = Array.isArray(req.body) ? req.body : Array.isArray(req.body?.results) ? req.body.results : [];
  const replace = Array.isArray(req.body) ? false : Boolean(req.body?.replace);

  if (!results.length) {
    return res.status(400).json({ error: "results array is required" });
  }

  try {
    const state = await readState();

    if (replace) {
      DSM_TIERS.forEach((tierKey) => {
        state.dsm[tierKey] = [];
      });
    }

    const applied = [];
    const rejected = [];

    results.forEach((row, index) => {
      const addResult = addOrMoveDsmUser(state, {
        tierInput: row?.tier,
        usernameInput: row?.username,
        highTierInput: row?.highTier,
        positionInput: row?.position,
        regionInput: row?.region
      });

      if (addResult.error) {
        rejected.push({ index, error: addResult.error });
      } else {
        applied.push({
          index,
          tier: addResult.tier,
          username: addResult.value.username,
          highTier: addResult.value.highTier
        });
      }
    });

    if (!applied.length) {
      return res.status(400).json({ error: "No valid DSM results to apply", rejected });
    }

    rebuildOverallFromDsm(state);
    applied.forEach((entry) => {
      entry.overallTier = getOverallRankByUsername(state, entry.username);
    });

    await writeState(state);
    return res.json({
      ok: true,
      mode: "dsm",
      applied,
      rejected,
      updatedAt: state.updatedAt
    });
  } catch (error) {
    console.error("POST /api/dsm-results failed:", error);
    return res.status(500).json({ error: "Failed to update DSM results" });
  }
});

app.post("/api/bulk-sync", requireSecret, async (req, res) => {
  try {
    const state = await readState();

    if (req.body?.overall && typeof req.body.overall === "object") {
      const stagedOverall = Object.fromEntries(
        OVERALL_TIERS.map((rankKey) => [rankKey, sanitizeOverallEntry(state.overall[rankKey], null)])
      );

      Object.entries(req.body.overall).forEach(([slot, value]) => {
        const parsed = parseOverallTierInput(slot);
        if (!parsed) {
          return;
        }

        stagedOverall[parsed.rank] = sanitizeOverallEntry(value, parsed.fallbackTag);
      });

      writeOverallEntriesByPoints(state, Object.values(stagedOverall).filter(Boolean));
    }

    if (req.body?.dsm && typeof req.body.dsm === "object") {
      DSM_TIERS.forEach((tier) => {
        if (Object.prototype.hasOwnProperty.call(req.body.dsm, tier)) {
          const nextList = Array.isArray(req.body.dsm[tier]) ? req.body.dsm[tier] : [];
          state.dsm[tier] = nextList.map((entry) => sanitizeDsmEntry(entry)).filter(Boolean);
        }
      });

      rebuildOverallFromDsm(state);
    }

    await writeState(state);
    res.json({ ok: true, updatedAt: state.updatedAt });
  } catch (error) {
    console.error("POST /api/bulk-sync failed:", error);
    res.status(500).json({ error: "Failed to bulk sync tiers" });
  }
});

app.post("/api/reset", requireSecret, async (_req, res) => {
  try {
    const state = emptyState();
    await writeState(state);
    res.json({ ok: true, updatedAt: state.updatedAt });
  } catch (error) {
    console.error("POST /api/reset failed:", error);
    res.status(500).json({ error: "Failed to reset tiers" });
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use((error, req, res, next) => {
  if (error?.type === "entity.parse.failed") {
    console.warn(`[http] Invalid JSON payload on ${req.method} ${req.originalUrl}`);
    return res.status(400).json({
      error: "Invalid JSON body. Use valid JSON (double-quoted keys and strings)."
    });
  }
  return next(error);
});

async function start() {
  await readState();
  startDiscordBridge();

  app.listen(PORT, () => {
    console.log(`Tier server running on http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
