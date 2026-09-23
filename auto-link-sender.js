/**
 * HJ GROUPS - Telegram Auto Link Sender
 * Sends t.me/c/<channel>/<start>-<end> links to a target bot every N seconds.
 * Uses a Telegram USER session through MTProto (same stack as the existing project).
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
require("dotenv").config();

const ROOT = __dirname;
const SESSION_FILE = path.join(ROOT, "telegram-auto-link-session.txt");
const STATE_FILE = path.join(ROOT, "auto-link-sender-state.json");
const LOG_FILE = path.join(ROOT, "auto-link-sender.log");
const CONFIG_FILE = path.join(ROOT, "auto-link-sender-config.json");

const DEFAULT_BATCH_SIZE = Number(process.env.AUTO_BATCH_SIZE || 5);
const DEFAULT_DELAY_SECONDS = Number(process.env.AUTO_DELAY_SECONDS || 600);
const RETRY_DELAY_SECONDS = Number(process.env.AUTO_RETRY_DELAY_SECONDS || 30);

const API_ID = Number(process.env.API_ID || process.env.TELEGRAM_API_ID);
const API_HASH = String(process.env.API_HASH || process.env.TELEGRAM_API_HASH || "").trim();

let client = null;
let activeRun = null;
let stopped = false;
let paused = false;
let previousInputRawMode = false;

function stamp() {
  return new Date().toISOString();
}

function log(message) {
  const line = "[" + stamp() + "] " + message;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function normalizeBotUsername(value) {
  let v = String(value || "").trim();
  if (!v) return "";
  v = v.replace(/^https?:\/\/t\.me\//i, "");
  v = v.split(/[/?#]/)[0];
  if (!v.startsWith("@")) v = "@" + v;
  return v;
}

function parseRangeLink(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/https?:\/\/t\.me\/c\/(\d+)\/(\d+)(?:-(\d+))?/i);

  if (!match) {
    throw new Error("Invalid link. Use https://t.me/c/<channel>/<start>-<end>");
  }

  const channelId = match[1];
  const start = Number(match[2]);
  const end = Number(match[3] || match[2]);

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    throw new Error("Invalid Telegram message range.");
  }

  return { channelId, start, end };
}

function buildLink(channelId, start, end) {
  return "https://t.me/c/" + channelId + "/" + start + "-" + end;
}

function formatTime(seconds) {
  let s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  s %= 60;
  if (h > 0) return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    log("Could not read config file: " + err.message);
    return {};
  }
}

function saveConfig(config) {
  const tmp = CONFIG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(tmp, CONFIG_FILE);
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("Could not read state file: " + err.message);
    return null;
  }
}

function saveState(state) {
  const tmp = STATE_FILE + ".tmp";
  state.updatedAt = stamp();
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, STATE_FILE);
}

function clearState() {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch (err) {
    log("Could not remove state file: " + err.message);
  }
}

function validateConfig() {
  if (!Number.isInteger(API_ID) || API_ID <= 0) {
    throw new Error("API_ID / TELEGRAM_API_ID is missing or not numeric.");
  }
  if (!API_HASH) {
    throw new Error("API_HASH / TELEGRAM_API_HASH is missing.");
  }
  if (!Number.isInteger(DEFAULT_BATCH_SIZE) || DEFAULT_BATCH_SIZE < 1) {
    throw new Error("AUTO_BATCH_SIZE must be a positive integer.");
  }
  if (!Number.isFinite(DEFAULT_DELAY_SECONDS) || DEFAULT_DELAY_SECONDS < 1) {
    throw new Error("AUTO_DELAY_SECONDS must be at least 1 second.");
  }
}

async function loginTelegram() {
  const envSession = String(process.env.AUTO_LINK_TELEGRAM_SESSION || "").trim();
  const fileSession = fs.existsSync(SESSION_FILE)
    ? fs.readFileSync(SESSION_FILE, "utf8").trim()
    : "";
  const savedSession = envSession || fileSession;

  client = new TelegramClient(
    new StringSession(savedSession),
    API_ID,
    API_HASH,
    { connectionRetries: 5 }
  );

  if (savedSession) {
    await client.connect();
    const authorized = typeof client.isUserAuthorized === "function"
      ? await client.isUserAuthorized()
      : await client.checkAuthorization();

    if (authorized) {
      log("Telegram session connected.");
      return;
    }
  }

  console.log("\nTelegram first-time login");
  await client.start({
    phoneNumber: async function () {
      return await ask("Phone number (+91...): ");
    },
    password: async function () {
      return await ask("Telegram 2FA password (Enter if none): ");
    },
    phoneCode: async function () {
      return await ask("Telegram login code: ");
    },
    onError: function (err) {
      log("Telegram login error: " + err.message);
    }
  });

  const session = client.session.save();
  fs.writeFileSync(SESSION_FILE, session + "\n", "utf8");
  log("Telegram user session saved to " + path.basename(SESSION_FILE) + ".");
  log("Keep telegram-session.txt private.");
}

async function resolveBot(username) {
  const bot = normalizeBotUsername(username);
  if (!bot) throw new Error("Target bot username is empty.");
  const entity = await client.getEntity(bot);
  if (!entity) throw new Error("Could not resolve target bot " + bot + ".");
  return bot;
}

async function sendLink(botUsername, link) {
  await client.sendMessage(botUsername, {
    message: link,
    linkPreview: false
  });
}

function setupControls() {
  if (!process.stdin.isTTY) return;
  readline.emitKeypressEvents(process.stdin);
  try {
    previousInputRawMode = true;
    process.stdin.setRawMode(true);
  } catch (_) {
    previousInputRawMode = false;
    return;
  }

  process.stdin.on("keypress", function (_str, key) {
    if (!activeRun || !key) return;

    if (key.ctrl && key.name === "c") {
      stopped = true;
      paused = false;
      log("Stop requested. Current state will be saved.");
      return;
    }

    if (key.name === "p") {
      paused = true;
      log("Paused. Press R to resume.");
      return;
    }

    if (key.name === "r") {
      if (paused) {
        paused = false;
        log("Resumed.");
      }
      return;
    }

    if (key.name === "s") {
      stopped = true;
      paused = false;
      log("Stop requested. Current state will be saved.");
    }
  });
}

function cleanupControls() {
  if (previousInputRawMode && process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch (_) {}
  }
}

async function waitControlled(seconds) {
  let remaining = Math.ceil(seconds);

  while (remaining > 0 && !stopped) {
    while (paused && !stopped) {
      await sleep(250);
    }
    if (stopped) break;

    process.stdout.write("\rNext batch in " + formatTime(remaining) + "   ");
    await sleep(1000);
    remaining -= 1;
  }

  process.stdout.write("\r" + " ".repeat(50) + "\r");
}

function createRun(parsed, botUsername, batchSize, delaySeconds, lastMessageId) {
  const size = parsed.end - parsed.start + 1;
  if (size !== batchSize) {
    throw new Error(
      "First link must contain exactly " + batchSize +
      " messages. Example: 799-803."
    );
  }

  if (lastMessageId !== null && lastMessageId < parsed.end) {
    throw new Error("Last message ID must be >= the first link end ID.");
  }

  return {
    channelId: parsed.channelId,
    currentStart: parsed.start,
    currentEnd: parsed.end,
    batchSize: batchSize,
    delaySeconds: delaySeconds,
    targetBot: botUsername,
    lastMessageId: lastMessageId,
    sentBatches: [],
    status: "running",
    createdAt: stamp(),
    updatedAt: stamp()
  };
}

async function run(state) {
  setupControls();
  activeRun = state;
  stopped = false;
  paused = false;
  saveState(state);

  console.log("\nControls: P=pause, R=resume, S=stop/save, Ctrl+C=stop/save\n");

  while (!stopped) {
    const start = state.currentStart;
    const end = state.currentEnd;

    if (state.lastMessageId !== null && end > state.lastMessageId) {
      state.status = "completed";
      saveState(state);
      log("The configured final message ID was reached.");
      clearState();
      break;
    }

    const link = buildLink(state.channelId, start, end);

    try {
      log("Sending " + link + " -> " + state.targetBot);
      await sendLink(state.targetBot, link);

      state.sentBatches.push({
        start: start,
        end: end,
        link: link,
        sentAt: stamp()
      });

      state.currentStart = end + 1;
      state.currentEnd = end + state.batchSize;
      state.status = "running";
      saveState(state);

      log("Sent successfully: " + start + "-" + end);

      if (state.lastMessageId !== null && end >= state.lastMessageId) {
        state.status = "completed";
        saveState(state);
        log("Final batch sent. Automation complete.");
        clearState();
        break;
      }

      await waitControlled(state.delaySeconds);
    } catch (err) {
      state.status = "retrying";
      saveState(state);
      log("Failed " + start + "-" + end + ": " + err.message);

      if (!stopped) {
        log("Retrying in " + formatTime(RETRY_DELAY_SECONDS) + ".");
        await waitControlled(RETRY_DELAY_SECONDS);
      }
    }
  }

  if (stopped) {
    state.status = "paused";
    saveState(state);
    log("Saved. Next batch remains " + state.currentStart + "-" + state.currentEnd + ".");
  }

  activeRun = null;
}

async function resumeExisting() {
  const state = loadState();
  if (!state) return false;

  console.log(
    "\nSaved run found: next batch " +
    state.currentStart + "-" + state.currentEnd +
    " -> " + state.targetBot
  );

  const answer = (await ask("Resume it? [Y/n]: ")).trim().toLowerCase();
  if (answer === "n" || answer === "no") {
    clearState();
    log("Saved run discarded.");
    return false;
  }

  state.targetBot = await resolveBot(state.targetBot);
  await run(state);
  return true;
}

async function createNew() {
  const rawLink = await ask(
    "\nPaste first link (example https://t.me/c/3607214438/799-803): "
  );
  const parsed = parseRangeLink(rawLink);

  const config = loadConfig();
  let botUsername = normalizeBotUsername(config.targetBot || process.env.AUTO_TARGET_BOT || "");

  if (!botUsername) {
    const botInput = await ask(
      "Target third-party bot username (example @my_bot): "
    );
    botUsername = await resolveBot(botInput);
    config.targetBot = botUsername;
  } else {
    botUsername = await resolveBot(botUsername);
  }

  const batchSize = Number(config.batchSize || DEFAULT_BATCH_SIZE);
  const delaySeconds = Number(config.delaySeconds || DEFAULT_DELAY_SECONDS);
  const configuredLast = process.env.AUTO_LAST_MESSAGE_ID || config.lastMessageId || "";
  const lastMessageId = configuredLast ? Number(configuredLast) : null;

  if (!config.targetBot) config.targetBot = botUsername;
  config.batchSize = batchSize;
  config.delaySeconds = delaySeconds;
  if (lastMessageId !== null) config.lastMessageId = lastMessageId;
  saveConfig(config);

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("Batch size must be a positive integer.");
  }
  if (!Number.isFinite(delaySeconds) || delaySeconds < 1) {
    throw new Error("Delay must be at least 1 second.");
  }
  if (lastMessageId !== null && (!Number.isSafeInteger(lastMessageId) || lastMessageId < parsed.end)) {
    throw new Error("Configured last message ID is invalid.");
  }

  const state = createRun(parsed, botUsername, batchSize, delaySeconds, lastMessageId);

  log("First batch: " + state.currentStart + "-" + state.currentEnd);
  log("Next batch: " + (state.currentEnd + 1) + "-" + (state.currentEnd + state.batchSize));
  log("Target bot: " + state.targetBot);

  await run(state);
}

async function main() {
  console.log("==============================================");
  console.log(" HJ GROUPS - Telegram Auto Link Sender");
  console.log("==============================================");

  try {
    validateConfig();
    await loginTelegram();

    const autoResume = process.argv.includes("--auto-resume");

    if (autoResume) {
      const state = loadState();
      if (!state) {
        log("No saved auto-sender job found at boot; nothing to resume.");
      } else {
        state.targetBot = await resolveBot(state.targetBot);
        await run(state);
      }
    } else {
      const resumed = await resumeExisting();
      if (!resumed) await createNew();
    }
  } catch (err) {
    log("ERROR: " + err.message);
    process.exitCode = 1;
  } finally {
    cleanupControls();
    if (client) {
      try { await client.disconnect(); } catch (_) {}
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseRangeLink: parseRangeLink,
  buildLink: buildLink,
  formatTime: formatTime
};
