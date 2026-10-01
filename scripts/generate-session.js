require("dotenv").config({ path: require("node:path").resolve(process.cwd(), ".env") });
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const readline = require("node:readline/promises");

function env(name) {
    return String(process.env[name] || "").trim();
}

const apiId = Number(env("API_ID") || env("TELEGRAM_API_ID"));
const apiHash = env("API_HASH") || env("TELEGRAM_API_HASH");

if (!Number.isInteger(apiId) || apiId <= 0) {
    console.error("Missing/invalid API_ID. Set API_ID or TELEGRAM_API_ID.");
    process.exit(1);
}

if (!apiHash) {
    console.error("Missing API_HASH. Set API_HASH or TELEGRAM_API_HASH.");
    process.exit(1);
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

const session = new StringSession("");
const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
});

async function main() {
    console.log("HJ GROUPS Telegram session generator");
    console.log("This runs locally and does not save the session to GitHub.");
    console.log("");

    await client.start({
        phoneNumber: async () => rl.question("Telegram phone number: "),
        password: async () => rl.question("Telegram 2FA password (press Enter if none): "),
        phoneCode: async (_isCodeViaApp, info) =>
            rl.question(
                "Telegram login code" +
                (info?.type ? " (" + String(info.type) + ")" : "") +
                ": "
            ),
        emailAddress: async () => rl.question("Telegram login email (only if requested): "),
        emailVerification: async () => ({
            type: "code",
            code: await rl.question("Telegram email verification code: "),
        }),
        onError: (error) => {
            console.error("Telegram login error:", error?.message || error);
        },
    });

    const me = await client.getMe();
    const saved = client.session.save();

    console.log("");
    console.log("Telegram authorization: SUCCESS");
    console.log("Logged in as:", me?.username ? "@" + me.username : (me?.firstName || "Telegram user"));
    console.log("");
    console.log("NEW TELEGRAM_SESSION:");
    console.log(saved);
    console.log("");
    console.log("Copy this value to Render -> HJ-Telegram-Streaming -> Environment");
    console.log("Variable: TELEGRAM_SESSION");
    console.log("Do NOT commit or share the session string.");
    console.log("");

    await client.disconnect();
}

main()
    .catch((error) => {
        console.error("");
        console.error("Session generation failed:", error?.message || error);
        process.exitCode = 1;
    })
    .finally(() => {
        rl.close();
    });
