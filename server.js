const express = require("express");
const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const FILE_NAME = "TEST.m4a";

const API_ID = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const CHANNEL_ID = Number(process.env.CHANNEL_ID);

if (!process.env.API_ID || isNaN(API_ID)) {
    console.error("❌ Startup Error: API_ID is missing or not numeric.");
    process.exit(1);
}
if (!API_HASH) {
    console.error("❌ Startup Error: API_HASH is missing.");
    process.exit(1);
}
if (!process.env.CHANNEL_ID || isNaN(CHANNEL_ID)) {
    console.error("❌ Startup Error: CHANNEL_ID is missing or not numeric.");
    process.exit(1);
}

const SESSION_FILE = path.join(__dirname, "telegram-session.txt");
const fileSession = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, "utf8").trim() : "";
const envSession = (process.env.TELEGRAM_SESSION || "").trim();
const savedSession = envSession || fileSession;

if (process.env.NODE_ENV === "production" && !envSession) {
    console.error("❌ Startup Error: TELEGRAM_SESSION is required in production.");
    process.exit(1);
}

console.log(
    "Telegram session source:",
    envSession ? "environment" : (fileSession ? "file" : "missing")
);

const client = new TelegramClient(new StringSession(savedSession), API_ID, API_HASH, { connectionRetries: 5 });

async function connectTelegram() {
    console.log("🔄 Connecting to Telegram...");
    await client.connect();
    if (!(await client.isUserAuthorized())) {
        throw new Error("❌ Telegram session is not authorized.");
    }
    console.log("✅ Telegram session connected!");
}

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
        const messages = await client.getMessages(CHANNEL_ID, { limit });

        const audioMessages = [];
        for (const msg of messages) {
            if (msg.media && msg.media.document && msg.media.document.mimeType && msg.media.document.mimeType.startsWith('audio/')) {
                const doc = msg.media.document;
                let fileName = 'audio.m4a';
                let duration = 0;

                if (doc.attributes) {
                    for (const attr of doc.attributes) {
                        if (attr.className === 'DocumentAttributeFilename') {
                            fileName = attr.fileName;
                        }
                        if (attr.className === 'DocumentAttributeAudio') {
                            duration = attr.duration;
                        }
                    }
                }

                audioMessages.push({
                    messageId: msg.id,
                    fileName,
                    mimeType: doc.mimeType,
                    size: Number(doc.size),
                    duration,
                    date: msg.date,
                    caption: msg.message || ''
                });
            }
        }

        res.json(audioMessages);
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

        const [targetMessage] = await client.getMessages(CHANNEL_ID, { ids: [messageId] });
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

        const [targetMessage] = await client.getMessages(CHANNEL_ID, { ids: [messageId] });
        if (!targetMessage || !targetMessage.file) return res.status(404).end();

        setMediaHeaders(res, targetMessage);
        res.status(200).end();
    } catch (e) {
        console.error('HEAD video error:', e);
        res.status(500).end();
    }
});

// Deliberately no /download/message/:messageId route.
app.get('/audio/message/:messageId', async (req, res) => {
    const messageId = Number(req.params.messageId);
    try {
        if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).send('Invalid message id');

        const [targetMessage] = await client.getMessages(CHANNEL_ID, { ids: [messageId] });
        if (!targetMessage || !targetMessage.file) return res.status(404).send('Not found');

        setMediaHeaders(res, targetMessage);
        await streamMedia(req, res, targetMessage);
    } catch(e) {
        console.error('Audio route error:', e);
        if (!res.headersSent) res.status(500).send('Error');
        else res.destroy(e);
    }
});

app.get('/video/message/:messageId', async (req, res) => {
    const messageId = Number(req.params.messageId);
    try {
        if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).send('Invalid message id');

        const [targetMessage] = await client.getMessages(CHANNEL_ID, { ids: [messageId] });
        if (!targetMessage || !targetMessage.file) return res.status(404).send('Not found');

        setMediaHeaders(res, targetMessage);
        await streamMedia(req, res, targetMessage);
    } catch(e) {
        console.error('Video route error:', e);
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

        for await (const chunk of client.iterDownload(targetMessage, { offset: alignedOffset })) {
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
    await connectTelegram();
    app.listen(PORT, () => {
        console.log("\n======================================");
        console.log("🚀 HJ GROUPS STREAM SERVER");
        console.log("======================================");
        console.log(`🌐 http://localhost:${PORT}`);
        console.log(`🎵 http://localhost:${PORT}/audio/message/7`);
        console.log("======================================\n");
    });
}

startServer().catch((error) => {
    console.error("\n❌ SERVER START ERROR:");
    console.error(error);
    process.exit(1);
});
