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
let reconnectPromise = null;

const LOCK_FILE = path.join(ROOT, "auto-link-sender.lock");
const CONTROL_FILE = path.join(ROOT, "auto-link-sender-control.txt");

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

function clearControl() {
  try {
    if (fs.existsSync(CONTROL_FILE)) fs.unlinkSync(CONTROL_FILE);
  } catch (err) {
    log("Could not clear control file: " + err.message);
  }
}

function readControl() {
  try {
    if (!fs.existsSync(CONTROL_FILE)) return "";
    return fs.readFileSync(CONTROL_FILE, "utf8").trim().toUpperCase();
  } catch (err) {
    log("Could not read control file: " + err.message);
    return "";
  }
}

function consumeControl() {
  const command = readControl();
  if (!command) return "";
  if (command === "PAUSE" || command === "RESUME" || command === "STOP") {
    try { fs.unlinkSync(CONTROL_FILE); } catch (_) {}
    return command;
  }
  clearControl();
  return "";
}

function applyExternalControl(state) {
  const command = consumeControl();
  if (!command) return;

  if (command === "PAUSE") {
    paused = true;
    state.status = "paused";
    saveState(state);
    log("Paused by external control. Current batch remains " + state.currentStart + "-" + state.currentEnd + ".");
  } else if (command === "RESUME") {
    paused = false;
    stopped = false;
    state.status = "running";
    saveState(state);
    log("Resumed by external control.");
  } else if (command === "STOP") {
    stopped = true;
    paused = false;
    state.status = "stopped";
    saveState(state);
    log("Stop requested by external control. Current batch remains " + state.currentStart + "-" + state.currentEnd + ".");
  }
}

function clearState() {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch (err) {
    log("Could not remove state file: " + err.message);
  }
}

function acquireProcessLock() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
      const pid = Number(lock.pid);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          throw new Error(
            "Another HJ Telegram Auto Sender process is already running (PID " + pid + ")."
          );
        } catch (err) {
          if (err && err.message && err.message.startsWith("Another HJ Telegram Auto Sender")) {
            throw err;
          }
          // PID is stale; replace the lock below.
        }
      }
    } catch (err) {
      if (err && err.message && err.message.startsWith("Another HJ Telegram Auto Sender")) {
        throw err;
      }
      // Invalid/stale lock file; replace it.
    }
  }

  fs.writeFileSync(
    LOCK_FILE,
    JSON.stringify({ pid: process.pid, startedAt: stamp() }) + "\n",
    "utf8"
  );
}

function releaseProcessLock() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return;
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (Number(lock.pid) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (_) {
    // Best-effort cleanup only.
  }
}

function isTelegramConnected() {
  if (!client) return false;
  if (typeof client.connected === "boolean") return client.connected;
  if (typeof client.isConnected === "function") {
    try { return Boolean(client.isConnected()); } catch (_) {}
  }
  // If the library does not expose connection state, let the API call decide.
  return true;
}

async function ensureTelegramConnected() {
  if (!client) throw new Error("Telegram client is not initialized.");
  if (isTelegramConnected()) return;

  if (!reconnectPromise) {
    reconnectPromise = (async function () {
      log("Telegram is disconnected. Reconnecting...");
      await client.connect();

      const authorized = typeof client.isUserAuthorized === "function"
        ? await client.isUserAuthorized()
        : await client.checkAuthorization();

      if (!authorized) {
        throw new Error("Telegram session is no longer authorized.");
      }

      log("Telegram reconnected successfully.");
    })().finally(function () {
      reconnectPromise = null;
    });
  }

  await reconnectPromise;
}

async function reconnectWithBackoff() {
  const delays = [0, 30, 60, 120, 300];
  let attempt = 0;

  while (!stopped) {
    const delay = delays[Math.min(attempt, delays.length - 1)];
    if (delay > 0) {
      log("Reconnect retry " + (attempt + 1) + " in " + formatTime(delay) + ".");
      await waitControlled(delay);
      if (stopped) return false;
    }

    try {
      // Force a fresh MTProto connection after a failed send. This is
      // important when the library still reports a stale "connected" flag.
      if (client) {
        try { await client.disconnect(); } catch (_) {}
      }
      await ensureTelegramConnected();
      return true;
    } catch (err) {
      log("Reconnect attempt " + (attempt + 1) + " failed: " + err.message);
      attempt += 1;
    }
  }

  return false;
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
  log("Keep telegram-auto-link-session.txt private.");
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
    if (activeRun) applyExternalControl(activeRun);
    while (paused && !stopped) {
      if (activeRun) applyExternalControl(activeRun);
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
  clearControl();
  saveState(state);

  console.log("\nControls: P=pause, R=resume, S=stop/save, Ctrl+C=stop/save\n");

  while (!stopped) {
    applyExternalControl(state);
    if (stopped) break;
    while (paused && !stopped) {
      applyExternalControl(state);
      await sleep(250);
    }
    if (stopped) break;

    const start = state.currentStart;
    const end = state.lastMessageId !== null
      ? Math.min(state.currentEnd, state.lastMessageId)
      : state.currentEnd;

    if (state.lastMessageId !== null && start > state.lastMessageId) {
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
        const recovered = await reconnectWithBackoff();

        if (recovered && !stopped) {
          log("Telegram connection is healthy again. Retrying the same unsent batch " + start + "-" + end + ".");
        } else if (!stopped) {
          log("Telegram is still unavailable. Retrying the same unsent batch after " + formatTime(RETRY_DELAY_SECONDS) + ".");
          await waitControlled(RETRY_DELAY_SECONDS);
        }
      }
    }
  }

  if (stopped) {
    if (state.status !== "stopped") state.status = "paused";
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
  const config = loadConfig();

  const rawLink = await ask(
    "\nPaste first link (example https://t.me/c/3607214438/799-803): "
  );
  const parsed = parseRangeLink(rawLink);

  const savedBot = normalizeBotUsername(
    config.targetBot || process.env.AUTO_TARGET_BOT || ""
  );
  const botPrompt = savedBot
    ? "Target third-party bot username [" + savedBot + "]: "
    : "Target third-party bot username (example @my_bot): ";
  const botInput = (await ask(botPrompt)).trim();
  const botValue = botInput || savedBot;

  if (!botValue) {
    throw new Error("Target bot username is required.");
  }

  const botUsername = await resolveBot(botValue);

  const savedBatchSize = Number(config.batchSize || DEFAULT_BATCH_SIZE);
  const batchPrompt =
    "Batch size [" + savedBatchSize + "]: ";
  const batchInput = (await ask(batchPrompt)).trim();
  const batchSize = Number(batchInput || savedBatchSize);

  const savedDelaySeconds = Number(config.delaySeconds || DEFAULT_DELAY_SECONDS);
  const delayPrompt =
    "Delay between links in seconds [" + savedDelaySeconds + "]: ";
  const delayInput = (await ask(delayPrompt)).trim();
  const delaySeconds = Number(delayInput || savedDelaySeconds);

  const savedLastMessageId = Number.isSafeInteger(Number(config.lastMessageId))
    ? Number(config.lastMessageId)
    : null;
  const lastPrompt = savedLastMessageId !== null
    ? "Stop message ID [" + savedLastMessageId + "] (blank = no limit): "
    : "Stop message ID (blank = no limit): ";
  const lastInput = (await ask(lastPrompt)).trim();
  const lastMessageId = lastInput ? Number(lastInput) : null;

  config.targetBot = botUsername;
  config.batchSize = batchSize;
  config.delaySeconds = delaySeconds;
  if (lastMessageId !== null) config.lastMessageId = lastMessageId;
  else delete config.lastMessageId;
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
    acquireProcessLock();
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
    releaseProcessLock();
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
