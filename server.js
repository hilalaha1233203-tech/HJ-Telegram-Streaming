const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const FILE_NAME = "TEST.m4a";

const ALLOWED_ORIGINS = new Set([
    "https://hj-groups-web.vercel.app",
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

// Premium/VIP media is issued as a short-lived signed ticket. The signing
// secret never reaches the browser.
const MEDIA_TICKET_TTL_MS = 2 * 60 * 60 * 1000;
const MEDIA_TICKET_SECRET = String(
    process.env.MEDIA_TICKET_SECRET ||
    process.env.TELEGRAM_SESSION ||
    API_HASH ||
    ''
).trim();

const SUPABASE_URL = String(
    process.env.SUPABASE_URL ||
    'https://yajkfglagnyvenddyvok.supabase.co'
).replace(/\/+$/, '');

const SUPABASE_KEY = String(
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    'sb_publishable_-cZxyr6HeB8H-dXNTUfNww_74XzTM6E'
).trim();

const HJ_WEB_BASE_URL = String(
    process.env.HJ_WEB_BASE_URL ||
    'https://hj-groups-website.getvoroa.com'
).trim().replace(/\/+$/, '');

const ADMIN_EMAIL = 'hilalaha1233203@gmail.com';
const mediaPolicyCache = new Map();
const MEDIA_POLICY_TTL_MS = 30_000;

function parseAccessTypes(raw) {
    if (Array.isArray(raw)) {
        return raw.map(String).map((x) => x.trim().toLowerCase()).filter(Boolean);
    }

    const text = String(raw ?? '').trim();
    if (!text) return ['free'];

    if (text.startsWith('[')) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
                return parsed.map(String).map((x) => x.trim().toLowerCase()).filter(Boolean);
            }
        } catch {}
    }

    return text
        .split(/[+,\s]+/)
        .map((x) => x.trim().toLowerCase())
        .filter((x) => ['free', 'vip', 'premium', 'ads'].includes(x));
}

function isProtectedPolicy(row) {
    const types = parseAccessTypes(row?.access_type);
    // Paid access always wins over legacy/accidental free or ads flags.
    return types.includes('premium') || types.includes('vip') || types.includes('ads');
}

async function supabaseJson(pathname, authHeader = '') {
    const headers = {
        apikey: SUPABASE_KEY,
        Accept: 'application/json',
    };
    if (authHeader) headers.Authorization = authHeader;

    const response = await fetch(SUPABASE_URL + pathname, { headers });
    let payload = null;
    try { payload = await response.json(); } catch {}

    if (!response.ok) {
        const error = new Error(
            'Supabase HTTP ' + response.status +
            (payload?.message ? ': ' + String(payload.message).slice(0, 220) : '')
        );
        error.statusCode = response.status;
        throw error;
    }
    return payload;
}

async function lookupMediaPolicy(kind, messageId) {
    const key = kind + ':' + messageId;
    const cached = mediaPolicyCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const table =
        kind === 'audio'
            ? 'episodes'
            : kind === 'video'
                ? 'video_episodes'
                : 'books';

    const select =
        kind === 'video'
            ? 'id,video_story_id,access_type,available,number'
            : kind === 'audio'
                ? 'id,story_id,access_type,available,episode_number,number'
                : 'id,access_type';

    const params = new URLSearchParams({
        select,
        telegram_message_id: 'eq.' + String(messageId),
        limit: '1',
    });

    try {
        const rows = await supabaseJson('/rest/v1/' + table + '?' + params.toString());
        const row = Array.isArray(rows) ? (rows[0] || null) : null;
        const value = { row, error: null };
        mediaPolicyCache.set(key, { value, expiresAt: Date.now() + MEDIA_POLICY_TTL_MS });
        return value;
    } catch (error) {
        const value = { row: null, error };
        mediaPolicyCache.set(key, { value, expiresAt: Date.now() + 5_000 });
        return value;
    }
}

const previewLimitCache = new Map();
const PREVIEW_LIMIT_TTL_MS = 30_000;

async function getEpisodePreviewLimit(kind) {
    const key = kind === 'video' ? 'video_free_episodes' : 'audio_free_episodes';
    const cached = previewLimitCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const params = new URLSearchParams({ select: key, id: 'eq.default', limit: '1' });
    try {
        const rows = await supabaseJson('/rest/v1/content_access_settings?' + params.toString());
        const value = Math.max(0, Number(Array.isArray(rows) ? rows[0]?.[key] : 0) || 0);
        previewLimitCache.set(key, { value, expiresAt: Date.now() + PREVIEW_LIMIT_TTL_MS });
        return value;
    } catch (error) {
        console.warn('Preview limit lookup failed:', error?.statusCode || 'request_error');
        previewLimitCache.set(key, { value: 0, expiresAt: Date.now() + 5_000 });
        return 0;
    }
}

function episodeNumberForPolicy(kind, row) {
    return Number(kind === 'video' ? row?.number : (row?.number ?? row?.episode_number));
}

async function isFreeEpisodePreview(kind, row) {
    if (!['audio', 'video'].includes(kind)) return false;
    const types = parseAccessTypes(row?.access_type);
    if (!types.some((type) => ['premium', 'vip', 'ads'].includes(type))) return false;
    const number = episodeNumberForPolicy(kind, row);
    if (!Number.isInteger(number) || number <= 0) return false;
    const limit = await getEpisodePreviewLimit(kind);
    return limit > 0 && number <= limit;
}

async function verifyWebEntitlement(authHeader, kind, row) {
    if (!authHeader) return { ok: false, status: 401, error: 'Login is required for protected media.' };
    const contentType = kind === 'document' ? 'book' : kind;
    const contentId = Number(row?.id);
    if (!Number.isInteger(contentId) || contentId <= 0) {
        return { ok: false, status: 400, error: 'Media record is invalid.' };
    }
    try {
        const response = await fetch(HJ_WEB_BASE_URL + '/api/shortener/access', {
            method: 'POST',
            headers: {
                Authorization: authHeader,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({ contentType, contentId }),
        });
        let payload = null;
        try { payload = await response.json(); } catch {}
        if (response.ok && payload?.ok) return { ok: true, payload };
        if (response.status === 401 || response.status === 403) {
            return { ok: false, status: response.status, error: String(payload?.error || 'Temporary or paid access required.') };
        }
        return { ok: false, status: 503, error: 'Protected media entitlement could not be verified.' };
    } catch (error) {
        console.warn('HJ web entitlement lookup failed:', error?.code || 'request_error');
        return { ok: false, status: 503, error: 'Protected media entitlement could not be verified.' };
    }
}

async function getSupabaseUser(authHeader) {
    if (!authHeader || !/^Bearer\s+\S+/i.test(authHeader)) return null;
    try {
        return await supabaseJson('/auth/v1/user', authHeader);
    } catch {
        return null;
    }
}

async function hasPurchaseForContent(userId, kind, row, authHeader) {
    if (!userId) return false;

    const candidateIds =
        kind === 'audio'
            ? [row?.story_id, row?.story_id == null ? null : 'tg-story-' + row.story_id]
            : kind === 'video'
                ? [row?.video_story_id, row?.video_story_id == null ? null : 'tg-video-' + row.video_story_id]
                : [row?.id, row?.id == null ? null : 'tg-book-' + row.id];

    const ids = new Set(
        candidateIds
            .filter((value) => value !== null && value !== undefined)
            .map(String)
    );
    if (!ids.size) return false;

    const params = new URLSearchParams({
        select: 'story_id,product_type,expires_at',
        user_id: 'eq.' + String(userId),
        limit: '200',
    });

    const rows = await supabaseJson('/rest/v1/purchases?' + params.toString(), authHeader);
    const now = Date.now();

    return (Array.isArray(rows) ? rows : []).some((purchase) => {
        if (!purchase || !ids.has(String(purchase.story_id))) return false;
        if (!purchase.expires_at) return true;
        const expiry = Date.parse(purchase.expires_at);
        return Number.isFinite(expiry) && expiry > now;
    });
}

function createMediaTicket(kind, messageId, userId) {
    if (!MEDIA_TICKET_SECRET) throw new Error('Media ticket secret is not configured.');

    const payload = Buffer.from(JSON.stringify({
        kind,
        messageId: Number(messageId),
        userId: String(userId),
        exp: Date.now() + MEDIA_TICKET_TTL_MS,
    })).toString('base64url');

    const signature = crypto
        .createHmac('sha256', MEDIA_TICKET_SECRET)
        .update(payload)
        .digest('base64url');

    return payload + '.' + signature;
}

function verifyMediaTicket(token, kind, messageId) {
    if (!MEDIA_TICKET_SECRET || !token) return null;

    const parts = String(token).split('.');
    if (parts.length !== 2) return null;

    const [payload, signature] = parts;
    const expected = crypto
        .createHmac('sha256', MEDIA_TICKET_SECRET)
        .update(payload)
        .digest('base64url');

    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;

    try {
        const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (value.kind !== kind) return null;
        if (Number(value.messageId) !== Number(messageId)) return null;
        if (!value.userId || Number(value.exp) <= Date.now()) return null;
        return value;
    } catch {
        return null;
    }
}

async function inspectMediaAccess(req, kind, messageId) {
    const ticket = String(req.query.ticket || '').trim();
    const ticketUser = verifyMediaTicket(ticket, kind, messageId);
    if (ticketUser) return { ok: true, viaTicket: true, userId: ticketUser.userId };

    const policyResult = await lookupMediaPolicy(kind, messageId);
    if (policyResult.error) {
        return { ok: false, status: 503, error: 'Media access policy could not be verified.' };
    }

    const row = policyResult.row;
    if (!row) {
        return { ok: false, status: 404, error: 'Media record was not found in the content database.' };
    }

    if (row.available === false) {
        return { ok: false, status: 403, error: 'This media is unavailable.' };
    }

    if (!isProtectedPolicy(row)) {
        return { ok: true, viaTicket: false, row };
    }

    if (await isFreeEpisodePreview(kind, row)) {
        return { ok: true, viaTicket: false, viaPreview: true, row };
    }

    const authHeader = String(req.headers.authorization || '').trim();
    if (!authHeader) {
        return { ok: false, status: 401, error: 'Login is required for protected media.' };
    }

    const accessTypes = parseAccessTypes(row.access_type);
    if (accessTypes.includes('ads')) {
        const entitlement = await verifyWebEntitlement(authHeader, kind, row);
        if (!entitlement.ok) return entitlement;
        const user = await getSupabaseUser(authHeader);
        return { ok: true, viaTicket: false, row, user };
    }

    const user = await getSupabaseUser(authHeader);
    if (!user?.id) {
        return { ok: false, status: 401, error: 'Invalid or expired login session.' };
    }

    if (String(user.email || '').toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
        return { ok: true, viaTicket: false, row, user };
    }

    try {
        const purchased = await hasPurchaseForContent(user.id, kind, row, authHeader);
        if (!purchased) {
            return { ok: false, status: 403, error: 'Premium purchase is required for this media.' };
        }
    } catch (error) {
        console.warn('Purchase lookup failed:', error?.statusCode || 'request_error');
        return { ok: false, status: 503, error: 'Premium entitlement could not be verified.' };
    }

    return { ok: true, viaTicket: false, row, user };
}

function sendAccessError(res, decision) {
    return res.status(decision.status || 403).json({
        error: decision.error || 'Media access denied',
    });
}

function publicBaseUrl(req) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = forwardedProto || 'https';
    const host = String(req.headers.host || '').trim();
    return host ? proto + '://' + host : '';
}

async function guardDirectMediaRoute(req, res, kind, messageId) {
    try {
        const access = await inspectMediaAccess(req, kind, messageId);
        if (!access.ok) {
            sendAccessError(res, access);
            return true;
        }

        if (access.viaTicket) return false;

        if (access.viaPreview) return false;

        if (isProtectedPolicy(access.row || {})) {
            res.status(403).send('Protected media requires a secure media ticket.');
            return true;
        }

        return false;
    } catch (error) {
        console.error('Protected media guard error:', error);
        res.status(503).send('Protected media access check failed.');
        return true;
    }
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
    // The global CORS middleware already sets the origin/header policy.
    res.status(204).end();
});

app.get('/telegram/messages', async (req, res) => {
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

        const requestedType = String(req.query.type || 'audio').toLowerCase();
        const mediaType = ['audio', 'video', 'document'].includes(requestedType)
            ? requestedType
            : 'audio';
        const mediaMessages = [];

        for (const msg of messages) {
            const doc = msg.media && msg.media.document;
            const mimeType = String(doc?.mimeType || '').toLowerCase();
            const attributes = Array.isArray(doc?.attributes) ? doc.attributes : [];
            const hasAudioAttribute = attributes.some((attr) => attr.className === 'DocumentAttributeAudio');
            const hasVideoAttribute = attributes.some((attr) => attr.className === 'DocumentAttributeVideo');

            if (!doc) continue;

            if (mediaType === 'audio' && !mimeType.startsWith('audio/') && !hasAudioAttribute) continue;
            if (mediaType === 'video' && !mimeType.startsWith('video/') && !hasVideoAttribute) continue;
            if (mediaType === 'document') {
                const looksLikeBook =
                    mimeType === 'application/pdf' ||
                    mimeType === 'application/epub+zip' ||
                    (!mimeType.startsWith('audio/') && !mimeType.startsWith('video/'));
                if (!looksLikeBook) continue;
            }

            let fileName =
                mediaType === 'video'
                    ? 'video.mp4'
                    : mediaType === 'document'
                        ? 'book.pdf'
                        : 'audio.m4a';
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
        if (await guardDirectMediaRoute(req, res, 'audio', messageId)) return;
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
        if (await guardDirectMediaRoute(req, res, 'video', messageId)) return;
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
        if (await guardDirectMediaRoute(req, res, 'document', messageId)) return;
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

// Protected media ticket endpoint. The browser receives only a short-lived
// signed URL after the Supabase login/purchase check succeeds.
app.get('/media-ticket/:type/message/:messageId', async (req, res) => {
    const type = String(req.params.type || '').toLowerCase();
    const messageId = Number(req.params.messageId);

    if (!['audio', 'video', 'document'].includes(type) ||
        !Number.isInteger(messageId) || messageId <= 0) {
        return res.status(400).json({ error: 'Invalid media ticket request' });
    }

    try {
        const access = await inspectMediaAccess(req, type, messageId);

        if (!access.ok) return sendAccessError(res, access);
        if (!access.row || !isProtectedPolicy(access.row)) {
            return res.status(400).json({ error: 'Media is not protected' });
        }

        const userId = String(access.user?.id || access.userId || '').trim();
        if (!userId) {
            return res.status(401).json({ error: 'Login is required for premium/VIP media.' });
        }

        const token = createMediaTicket(type, messageId, userId);
        const expiresAt = new Date(Date.now() + MEDIA_TICKET_TTL_MS).toISOString();
        const url = publicBaseUrl(req) +
            '/' + type + '/message/' + encodeURIComponent(messageId) +
            '?ticket=' + encodeURIComponent(token);

        res.setHeader('Cache-Control', 'no-store');
        return res.json({ url, expires_at: expiresAt });
    } catch (error) {
        console.error("Media ticket error:", error);
        return res.status(503).json({ error: 'Unable to verify protected media access.' });
    }
});

// Deliberately no /download/message/:messageId route.
app.get('/audio/message/:messageId', async (req, res) => {
    const messageId = Number(req.params.messageId);
    try {
        if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).send('Invalid message id');
        if (await guardDirectMediaRoute(req, res, 'audio', messageId)) return;

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
        if (await guardDirectMediaRoute(req, res, 'video', messageId)) return;

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

app.get('/document/preview/message/:messageId', async (req, res) => {
    const messageId = Number(req.params.messageId);
    try {
        if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).send('Invalid message id');
        const limit = await getBookPreviewLimit();
        if (limit <= 0) return res.status(403).send('Book preview is disabled.');
        const policyResult = await lookupMediaPolicy('document', messageId);
        if (policyResult.error) return res.status(503).send('Media access policy could not be verified.');
        const row = policyResult.row;
        if (!row) return res.status(404).send('Media record was not found in the content database.');
        if (row.available === false) return res.status(403).send('This media is unavailable.');
        if (!isProtectedPolicy(row)) return res.status(400).send('Media is not a protected book.');
        const telegram = await ensureTelegramConnected();
        const messages = await telegram.getMessages(CHANNEL_ID, { ids: [messageId] });
        const targetMessage = messages && messages[0];
        if (!targetMessage || !targetMessage.file) return res.status(404).send('Not found');
        const preview = await buildBookPreview(targetMessage, limit);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Disposition');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', preview.contentType);
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Content-Length', preview.body.length);
        return res.status(200).send(preview.body);
    } catch (error) {
        console.error('Document preview route error:', error);
        if (!res.headersSent) res.status(503).send('Book preview could not be generated.');
        else res.destroy(error);
    }
});

app.get('/document/message/:messageId', async (req, res) => {
    const messageId = Number(req.params.messageId);
    try {
        if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).send('Invalid message id');
        if (await guardDirectMediaRoute(req, res, 'document', messageId)) return;

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

const previewDocumentCache = new Map();
const PREVIEW_CACHE_TTL_MS = 10 * 60 * 1000;
const PREVIEW_CACHE_MAX_ITEMS = 3;
const PREVIEW_PAGE_LIMIT = 50;

async function downloadTelegramFileBuffer(targetMessage) {
    const chunks = [];
    let total = 0;
    for await (const chunk of (await ensureTelegramConnected()).iterDownload(targetMessage, { offset: 0 })) {
        const buffer = Buffer.from(chunk);
        total += buffer.length;
        if (total > 120 * 1024 * 1024) throw new Error('Preview source is too large.');
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

function cachePreview(key, value) {
    previewDocumentCache.set(key, { value, expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS });
    while (previewDocumentCache.size > PREVIEW_CACHE_MAX_ITEMS) {
        const oldest = previewDocumentCache.keys().next().value;
        previewDocumentCache.delete(oldest);
    }
}

function getCachedPreview(key) {
    const entry = previewDocumentCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        previewDocumentCache.delete(key);
        return null;
    }
    return entry.value;
}

async function getBookPreviewLimit() {
    const cached = previewLimitCache.get('book_free_pages');
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const params = new URLSearchParams({ select: 'book_free_pages', id: 'eq.default', limit: '1' });
    try {
        const rows = await supabaseJson('/rest/v1/content_access_settings?' + params.toString());
        const value = Math.max(0, Math.min(PREVIEW_PAGE_LIMIT, Number(Array.isArray(rows) ? rows[0]?.book_free_pages : 0) || 0));
        previewLimitCache.set('book_free_pages', { value, expiresAt: Date.now() + PREVIEW_LIMIT_TTL_MS });
        return value;
    } catch {
        previewLimitCache.set('book_free_pages', { value: 0, expiresAt: Date.now() + 5_000 });
        return 0;
    }
}

async function buildPdfPreview(sourceBuffer, pageLimit) {
    const { PDFDocument } = require('pdf-lib');
    const source = await PDFDocument.load(sourceBuffer, { ignoreEncryption: false });
    const count = Math.min(pageLimit, source.getPageCount());
    const output = await PDFDocument.create();
    const pages = await output.copyPages(source, Array.from({ length: count }, (_, index) => index));
    for (const page of pages) output.addPage(page);
    return Buffer.from(await output.save());
}

function stripMarkup(value) {
    return String(value || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function xmlEscape(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function htmlEscape(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function buildEpubPreview(sourceBuffer, title, pageLimit) {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(sourceBuffer);
    const names = Object.keys(zip.files);
    const containerName = names.find((name) => /(^|\/)META-INF\/container\.xml$/i.test(name));
    if (!containerName) throw new Error('EPUB container is missing.');
    const containerXml = await zip.file(containerName).async('string');
    const rootMatch = containerXml.match(/full-path=[\"']([^\"']+)[\"']/i);
    const rootFile = rootMatch ? rootMatch[1] : '';
    if (!rootFile || !zip.file(rootFile)) throw new Error('EPUB package metadata is invalid.');
    const opfDir = rootFile.includes('/') ? rootFile.slice(0, rootFile.lastIndexOf('/') + 1) : '';
    const opfXml = await zip.file(rootFile).async('string');
    const manifest = new Map();
    for (const match of opfXml.matchAll(/<item\b[^>]*\bid=[\"']([^\"']+)[\"'][^>]*\bhref=[\"']([^\"']+)[\"'][^>]*>/gi)) {
        manifest.set(match[1], match[2]);
    }
    const spine = [];
    for (const match of opfXml.matchAll(/<itemref\b[^>]*\bidref=[\"']([^\"']+)[\"'][^>]*>/gi)) {
        const href = manifest.get(match[1]);
        if (href) spine.push(href);
    }
    const chunks = [];
    for (const href of spine) {
        const fileName = opfDir + decodeURIComponent(String(href).replace(/^\/+/, ''));
        const file = zip.file(fileName);
        if (!file) continue;
        const text = stripMarkup(await file.async('string'));
        if (text) chunks.push(text);
    }
    const combined = chunks.join('\n\n').trim();
    if (!combined) throw new Error('EPUB contains no readable text.');
    const pageCount = Math.min(pageLimit, Math.max(1, Math.ceil(combined.length / 1400)));
    const pages = [];
    for (let index = 0; index < pageCount; index++) {
        const start = Math.floor((combined.length * index) / pageCount);
        const end = Math.floor((combined.length * (index + 1)) / pageCount);
        pages.push(combined.slice(start, end).trim());
    }
    const out = new JSZip();
    out.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    out.folder('META-INF').file('container.xml',
'<?xml version="1.0" encoding="UTF-8"?>' +
'<container version="1.0" xmlns="urn:oasis:names:tc:opendocument.org:xmlns:container">' +
'<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    const manifestXml = pages.map((_, index) => '<item id="p' + (index + 1) + '" href="page' + (index + 1) + '.xhtml" media-type="application/xhtml+xml"/>').join('');
    const spineXml = pages.map((_, index) => '<itemref idref="p' + (index + 1) + '"/>').join('');
    out.folder('OEBPS').file('content.opf',
'<?xml version="1.0" encoding="UTF-8"?>' +
'<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">' +
'<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">hj-groups-preview</dc:identifier><dc:title>' + xmlEscape(title || 'HJ GROUPS Book Preview') + '</dc:title><dc:language>en</dc:language></metadata>' +
'<manifest>' + manifestXml + '</manifest><spine>' + spineXml + '</spine></package>');
    const navItems = pages.map((_, index) => '<li><a href="page' + (index + 1) + '.xhtml">Page ' + (index + 1) + '</a></li>').join('');
    out.folder('OEBPS').file('nav.xhtml',
'<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>HJ GROUPS Preview</title></head><body><nav epub:type="toc"><ol>' + navItems + '</ol></nav></body></html>');
    pages.forEach((page, index) => {
        const body = htmlEscape(page).replace(/\n\n/g, '</p><p>');
        const xhtml = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Page ' + (index + 1) + '</title><style>body{font-family:serif;line-height:1.65;margin:8%;}</style></head><body><h1>' + htmlEscape(title || 'HJ GROUPS Book Preview') + ' — Page ' + (index + 1) + '</h1><p>' + body + '</p></body></html>';
        out.folder('OEBPS').file('page' + (index + 1) + '.xhtml', xhtml);
    });
    return Buffer.from(await out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

async function buildBookPreview(targetMessage, pageLimit) {
    const key = 'book-preview:' + String(targetMessage && targetMessage.id);
    const cached = getCachedPreview(key);
    if (cached) return cached;
    const sourceBuffer = await downloadTelegramFileBuffer(targetMessage);
    const name = String(targetMessage?.file?.name || '').toLowerCase();
    const mime = String(targetMessage?.file?.mimeType || targetMessage?.media?.document?.mimeType || '').toLowerCase();
    const isEpub = name.endsWith('.epub') || mime === 'application/epub+zip';
    const result = isEpub
        ? { body: await buildEpubPreview(sourceBuffer, targetMessage?.file?.name || 'HJ GROUPS Book', pageLimit), contentType: 'application/epub+zip' }
        : { body: await buildPdfPreview(sourceBuffer, pageLimit), contentType: 'application/pdf' };
    cachePreview(key, result);
    return result;
}
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
    const server = app.listen(PORT, () => {
        console.log("\n======================================");
        console.log("🚀 HJ GROUPS STREAM SERVER");
        console.log("======================================");
        console.log(`🌐 http://localhost:${PORT}`);
        console.log(`🎵 http://localhost:${PORT}/audio/message/7`);
        console.log("======================================\n");
    });

    // Do not crash the HTTP service when Telegram authentication is temporarily
    // invalid. Render/Vercel can keep the service healthy while media endpoints
    // retry the connection on demand.
    try {
        await ensureTelegramConnected();
    } catch (error) {
        console.error("⚠️ Telegram startup connection failed; media requests will retry:", error?.message || error);
    }

    return server;
}

if (require.main === module) {
    startServer().catch((error) => {
        console.error("\n❌ SERVER START ERROR:");
        console.error(error);
        process.exit(1);
    });
}

module.exports = app;
