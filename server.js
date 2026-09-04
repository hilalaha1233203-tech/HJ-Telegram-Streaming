const express = require("express");
const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
require("dotenv").config();

const app = express();
const PORT = 3000;
const CHANNEL_ID = -1004407564857;
const FILE_NAME = "TEST.m4a";

const SESSION_FILE = path.join(__dirname, "telegram-session.txt");
const API_ID = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;

const savedSession = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, "utf8").trim() : "";
const client = new TelegramClient(new StringSession(savedSession), API_ID, API_HASH, { connectionRetries: 5 });

async function connectTelegram() {
    console.log("🔄 Connecting to Telegram...");
    await client.connect();
    if (!(await client.isUserAuthorized())) {
        throw new Error("❌ Telegram session is not authorized.");
    }
    console.log("✅ Telegram session connected!");
}

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
<br><br>
<a href="/download/message/7" target="_blank" style="color:#7C83FF;">Download audio</a>
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

app.head('/audio/message/:messageId', async (req, res) => {
    try {
        const messageId = Number(req.params.messageId);
        const [targetMessage] = await client.getMessages(CHANNEL_ID, { ids: [messageId] });
        if (!targetMessage || !targetMessage.media || !targetMessage.media.document) {
            return res.status(404).end();
        }
        res.setHeader('Content-Length', Number(targetMessage.file.size));
        res.setHeader('Content-Type', targetMessage.file.mimeType || 'audio/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-cache');
        res.status(200).end();
    } catch (e) {
        res.status(500).end();
    }
});

app.get('/download/message/:messageId', async (req, res) => {
    const messageId = Number(req.params.messageId);
    try {
        const [targetMessage] = await client.getMessages(CHANNEL_ID, { ids: [messageId] });
        if (!targetMessage || !targetMessage.file) return res.status(404).send('Not found');
        res.setHeader('Content-Disposition', 'attachment; filename="' + (targetMessage.file.name || 'audio.m4a') + '"');
        await streamAudio(req, res, targetMessage);
    } catch(e) { res.status(500).send('Error'); }
});

app.get('/audio/message/:messageId', async (req, res) => {
    const messageId = Number(req.params.messageId);
    try {
        const [targetMessage] = await client.getMessages(CHANNEL_ID, { ids: [messageId] });
        if (!targetMessage || !targetMessage.file) return res.status(404).send('Not found');
        await streamAudio(req, res, targetMessage);
    } catch(e) { res.status(500).send('Error'); }
});

async function streamAudio(req, res, targetMessage) {
    const fileSize = Number(targetMessage.file.size);
    try {
        const rangeHeader = req.headers.range;
        console.log("\n🎧 AUDIO REQUEST");
        console.log("Range:", rangeHeader || "none");

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
            if (match[2]) {
                end = Number(match[2]);
            }
            if (start >= fileSize || start > end) {
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
        res.setHeader("Content-Type", targetMessage.file.mimeType || "audio/mp4");
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Cache-Control", "no-cache");

        console.log(`📡 HTTP range: ${start} → ${end}`);
        console.log(`📦 HTTP bytes: ${contentLength}`);

        const TELEGRAM_CHUNK_SIZE = 512 * 1024;
        const ALIGN = 4096;
        let currentOffset = start;
        let remaining = contentLength;
        let totalSent = 0;

        while (remaining > 0 && !res.destroyed) {
            const alignedOffset = Math.floor(currentOffset / ALIGN) * ALIGN;
            const skipBytes = currentOffset - alignedOffset;
            const chunk1MB = 1048576;
            const remainingInChunk = chunk1MB - (alignedOffset % chunk1MB);

            let requestSize = TELEGRAM_CHUNK_SIZE;
            while (requestSize > remainingInChunk && requestSize > ALIGN) {
                requestSize /= 2;
            }

            console.log(`⬇️  TG chunk: aligned=${alignedOffset} skip=${skipBytes} req=${requestSize}`);

            let chunkReceived = 0;
            let skipRemaining = skipBytes;

            for await (const chunk of client.iterDownload(targetMessage, { offset: alignedOffset, requestSize: requestSize })) {
                if (res.destroyed) break;
                let data = chunk;
                if (skipRemaining > 0) {
                    if (data.length <= skipRemaining) {
                        skipRemaining -= data.length;
                        chunkReceived += data.length;
                        continue;
                    }
                    data = data.subarray(skipRemaining);
                    chunkReceived += skipRemaining;
                    skipRemaining = 0;
                }
                const allowed = Math.min(data.length, remaining);
                const output = data.subarray(0, allowed);
                if (output.length > 0) {
                    res.write(output);
                    totalSent += output.length;
                    currentOffset += output.length;
                    remaining -= output.length;
                    chunkReceived += output.length;
                }
                if (chunkReceived >= requestSize) break;
                if (remaining <= 0) break;
            }

            if (chunkReceived === 0) {
                console.error("❌ Telegram returned 0 bytes.");
                break;
            }

            if (!res.destroyed && !res.writableNeedDrain) {
                continue;
            }
            if (!res.destroyed && res.writableNeedDrain) {
                await new Promise((resolve) => {
                    res.once("drain", resolve);
                });
            }
        }
        console.log(`✅ Streamed ${totalSent} bytes`);
        if (!res.destroyed) {
            res.end();
        }
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