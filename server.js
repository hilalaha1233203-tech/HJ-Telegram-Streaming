const express = require("express");
const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const FILE_NAME = "TEST.m4a";

const ALLOWED_ORIGINS = new Set([
    "https://hj-groups-website.getvoroa.com",
]);

// CORS must run before every route, including OPTIONS preflight requests.
app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin && ALLOWED_ORIGINS.has(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    }

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, HEAD, OPTIONS"
    );
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Range"
    );
    res.setHeader(
        "Access-Control-Expose-Headers",
        "Content-Length, Content-Range, Accept-Ranges, Content-Disposition, Content-Type"
    );
    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    next();
});

// Support both the original variable names and the clearer Vercel names.
const API_ID = Number(process.env.API_ID || process.env.TELEGRAM_API_ID);
const API_HASH = (process.env.API_HASH || process.env.TELEGRAM_API_HASH || "").trim();
const CHANNEL_ID = Number(process.env.CHANNEL_ID);

const SESSION_FILE = path.join(__dirname, "telegram-session.txt");
const fileSession = fs.existsSync(SESSION_FILE)
    ? fs.readFileSync(SESSION_FILE, "utf8").trim()
    : "";
const envSession = (process.env.TELEGRAM_SESSION || "").trim();
const savedSession = envSession || fileSession;

let client = null;
let telegramConnectionPromise = null;

function validateTelegramConfig() {
    const problems = [];

    if ((!process.env.API_ID && !process.env.TELEGRAM_API_ID) || !Number.isInteger(API_ID) || API_ID <= 0) {
        problems.push("API_ID / TELEGRAM_API_ID is missing or not numeric");
    }
    if (!API_HASH) {
        problems.push("API_HASH / TELEGRAM_API_HASH is missing");
    }
    if (!process.env.CHANNEL_ID || !Number.isInteger(CHANNEL_ID) || CHANNEL_ID === 0) {
        problems.push("CHANNEL_ID is missing or not numeric");
    }
    if (!savedSession) {
        problems.push("TELEGRAM_SESSION is missing");
    }

    return problems;
}

async function connectTelegram() {
    const problems = validateTelegramConfig();
    if (problems.length) {
        throw new Error("Telegram configuration error: " + problems.join("; "));
    }

    if (!client) {
        console.log(
            "Telegram session source:",
            envSession ? "environment" : (fileSession ? "file" : "missing")
        );

        client = new TelegramClient(
            new StringSession(savedSession),
            API_ID,
            API_HASH,
            { connectionRetries: 5 }
        );
    }

    console.log("🔄 Connecting to Telegram...");
    await client.connect();

    if (!(await client.isUserAuthorized())) {
        throw new Error("❌ Telegram session is not authorized.");
    }

    console.log("✅ Telegram session connected!");
    return client;
}

async function ensureTelegramConnected() {
    if (!telegramConnectionPromise) {
        telegramConnectionPromise = connectTelegram().catch((error) => {
            telegramConnectionPromise = null;
            throw error;
        });
    }

    return telegramConnectionPromise;
}

app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});

app.get('/telegram/status', (req, res) => {
    const config = validateTelegramConfig();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(config.length ? 503 : 200).json({
        ok: config.length === 0,
        telegramConfigured: config.length === 0,
        missing: config.map((item) => item.split(' is ')[0]),
    });
});

app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", service: "hj-telegram-streaming" });
});

app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HJ GROUPS Streaming Test</title>
</head>
<body style="margin:0; padding:40px; background:#111; color:white; font-family:Arial,sans-serif;">
<h1>HJ GROUPS Telegram Streaming</h1>
<audio controls preload="metadata" style="width:100%; max-width:700px;" src="/audio/message/7"></audio>
</body>
</html>`);
});

app.options('/telegram/messages', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization');
    res.status(200).end();
});

app.get('/telegram/messages', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization');

    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Unauthorized: Missing Authorization header' });

    try {
        const authResponse = await fetch('https://yajkfglagnyvenddyvok.supabase.co/auth/v1/user', {
            headers: {
                'Authorization': authHeader,
                'apikey': 'sb_publishable_-cZxyr6HeB8H-dXNTUfNww_74XzTM6E'
            }
        });

        if (!authResponse.ok) return res.status(401).json({ error: 'Invalid Supabase token' });

        const user = await authResponse.json();
        if (user.email !== 'hilalaha1233203@gmail.com') {
            return res.status(403).json({ error: 'Forbidden: Admin access required' });
        }

        const limit = Number(req.query.limit) || 100;
        const telegram = await ensureTelegramConnected();
        const messages = await telegram.getMessages(CHANNEL_ID, { limit });

        const mediaType = req.query.type === 'video' ? 'video' : 'audio';
        const mediaMessages = [];

        for (const msg of messages) {
            const doc = msg.media && msg.media.document;
            const mimeType = String(doc?.mimeType || '');

            if (!doc || !mimeType.startsWith(mediaType + '/')) continue;

            let fileName = mediaType === 'video' ? 'video.mp4' : 'audio.m4a';
            let duration = 0;
            let width = 0;
            let height = 0;

            if (doc.attributes) {
                for (const attr of doc.attributes) {
                    if (attr.className === 'DocumentAttributeFilename' && attr.fileName) {
                        fileName = attr.fileName;
                    }
                    if (attr.className === 'DocumentAttributeAudio') {
                        duration = attr.duration || 0;
                    }
                    if (attr.className === 'DocumentAttributeVideo') {
                        duration = attr.duration || 0;
                        width = attr.w || 0;
                        height = attr.h || 0;
                    }
                }
            }

            mediaMessages.push({
                messageId: msg.id,
                fileName,
                mimeType,
                size: Number(doc.size),
                duration,
                width,
                height,
                date: msg.date,
                caption: msg.message || ''
            });
        }

        res.json(mediaMessages);
    } catch (e) {
        console.error('Error fetching telegram messages:', e);
        res.status(500).json({ error: 'Internal server error while fetching Telegram messages' });
    }
});

function setMediaHeaders(res, targetMessage) {
    const mimeType = targetMessage?.file?.mimeType || targetMessage?.media?.document?.mimeType || 'audio/mp4';
    const fileSize = Number(targetMessage?.file?.size || targetMessage?.media?.document?.size || 0);
    const rawName = targetMessage?.file?.name || 'media';
    const safeName = String(rawName).replace(/[\\\"\r\n]/g, '_');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, Content-Type');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Content-Type', mimeType);

    if (fileSize > 0) {
        res.setHeader('Content-Length', fileSize);
    }

    res.setHeader('Content-Disposition', 'inline; filename="' + safeName + '"');
}

app.head('/audio/message/:messageId', async (req, res) => {
    try {
        const messageId = Number(req.params.messageId);
        if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).end();

        const telegram = await ensureTelegramConnected();
        const [targetMessage] = await telegram.getMessages(CHANNEL_ID, { ids: [messageId] });
        if (!targetMessage || !targetMessage.file) return res.status(404).end();

        setMediaHeaders(res, targetMessage);
        res.status(200).end();
    } catch (e) {
        console.error('HEAD media error:', e);
        res.status(500).end();
    }
});

app.head('/video/message/:messageId', async (req, res) => {
    try {
        const messageId = Number(req.params.messageId);
        if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).end();

        const telegram = await ensureTelegramConnected();
        const [targetMessage] = await telegram.getMessages(CHANNEL_ID, { ids: [messageId] });
        if (!targetMessage || !targetMessage.file) return res.status(404).end();

        setMediaHeaders(res, targetMessage);
        res.status(200).end();
    } catch (e) {
        console.error('HEAD video error:', e);
        res.status(500).end();
    }
});

app.head('/document/message/:messageId', async (req, res) => {
    try {
        const messageId = Number(req.params.messageId);
        if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).end();

        const telegram = await ensureTelegramConnected();
        const [targetMessage] = await telegram.getMessages(CHANNEL_ID, { ids: [messageId] });
        if (!targetMessage || !targetMessage.file) return res.status(404).end();

        setMediaHeaders(res, targetMessage);
        res.status(200).end();
    } catch (e) {
        console.error('HEAD document error:', e);
        res.status(500).end();
    }
});

// Deliberately no /download/message/:messageId route.
app.get('/audio/message/:messageId', async (req, res) => {
    const messageId = Number(req.params.messageId);
    try {
        if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).send('Invalid message id');

        const telegram = await ensureTelegramConnected();
        const [targetMessage] = await telegram.getMessages(CHANNEL_ID, { ids: [messageId] });
        if (!targetMessage || !targetMessage.file) return res.status(404).send('Not found');

        setMediaHeaders(res, targetMessage);
        await streamMedia(req, res, targetMessage);
    } catch(e) {
        console.error('Audio route error:', e);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Telegram audio streaming failed',
                message: String(e?.message || e),
            });
        } else {
            res.destroy(e);
        }
    }
});

app.get('/video/message/:messageId', async (req, res) => {
    const messageId = Number(req.params.messageId);
    try {
        if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).send('Invalid message id');

        const telegram = await ensureTelegramConnected();
        const [targetMessage] = await telegram.getMessages(CHANNEL_ID, { ids: [messageId] });
        if (!targetMessage || !targetMessage.file) return res.status(404).send('Not found');

        setMediaHeaders(res, targetMessage);
        await streamMedia(req, res, targetMessage);
    } catch(e) {
        console.error('Video route error:', e);
        if (!res.headersSent) res.status(500).send('Error');
        else res.destroy(e);
    }
});

app.get('/document/message/:messageId', async (req, res) => {
    const messageId = Number(req.params.messageId);
    try {
        if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).send('Invalid message id');

        const telegram = await ensureTelegramConnected();
        const [targetMessage] = await telegram.getMessages(CHANNEL_ID, { ids: [messageId] });
        if (!targetMessage || !targetMessage.file) return res.status(404).send('Not found');

        setMediaHeaders(res, targetMessage);
        await streamMedia(req, res, targetMessage);
    } catch(e) {
        console.error('Document route error:', e);
        if (!res.headersSent) res.status(500).send('Error');
        else res.destroy(e);
    }
});

async function streamMedia(req, res, targetMessage) {
    const fileSize = Number(targetMessage.file.size);
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
        return res.status(404).send('File size unavailable');
    }

    try {
        const rangeHeader = req.headers.range;
        let start = 0;
        let end = fileSize - 1;

        if (rangeHeader) {
            const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (!match) {
                res.status(416);
                res.setHeader("Content-Range", `bytes */${fileSize}`);
                return res.end();
            }

            start = Number(match[1]);
            if (match[2]) end = Number(match[2]);

            if (!Number.isFinite(start) || !Number.isFinite(end) || start >= fileSize || start > end) {
                res.status(416);
                res.setHeader("Content-Range", `bytes */${fileSize}`);
                return res.end();
            }

            end = Math.min(end, fileSize - 1);
        }

        const contentLength = end - start + 1;

        if (rangeHeader) {
            res.status(206);
            res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
        } else {
            res.status(200);
        }

        res.setHeader("Content-Length", contentLength);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

        const ALIGN = 1048576;
        const alignedOffset = Math.floor(start / ALIGN) * ALIGN;
        const skipBytes = start - alignedOffset;
        let skipRemaining = skipBytes;
        let remaining = contentLength;
        let totalSent = 0;

        for await (const chunk of (await ensureTelegramConnected()).iterDownload(targetMessage, { offset: alignedOffset })) {
            if (res.destroyed) break;

            let data = chunk;

            if (skipRemaining > 0) {
                if (data.length <= skipRemaining) {
                    skipRemaining -= data.length;
                    continue;
                }
                data = data.subarray(skipRemaining);
                skipRemaining = 0;
            }

            const allowed = Math.min(data.length, remaining);
            const output = data.subarray(0, allowed);

            if (output.length > 0) {
                const writeOk = res.write(output);
                totalSent += output.length;
                remaining -= output.length;

                if (!writeOk && !res.destroyed) {
                    await new Promise((resolve) => res.once("drain", resolve));
                }
            }

            if (remaining <= 0) break;
        }

        if (remaining > 0 && !res.destroyed) {
            console.error(`❌ Telegram stream ended early. Remaining: ${remaining} bytes`);
        }

        console.log(`✅ Streamed ${totalSent} bytes`);
        if (!res.destroyed) res.end();
    } catch (error) {
        console.error("\n❌ STREAM ERROR:");
        console.error(error);
        if (!res.headersSent) {
            res.status(500).send("Telegram streaming error.");
        } else {
            res.destroy(error);
        }
    }
}

async function startServer() {
    await ensureTelegramConnected();
    app.listen(PORT, () => {
        console.log("\n======================================");
        console.log("🚀 HJ GROUPS STREAM SERVER");
        console.log("======================================");
        console.log(`🌐 http://localhost:${PORT}`);
        console.log(`🎵 http://localhost:${PORT}/audio/message/7`);
        console.log("======================================\n");
    });
}

if (require.main === module) {
    startServer().catch((error) => {
        console.error("\n❌ SERVER START ERROR:");
        console.error(error);
        process.exit(1);
    });
}

module.exports = app;
