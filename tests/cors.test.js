const test = require("node:test");
const assert = require("node:assert/strict");

const app = require("../server.js");

let server;
let baseUrl;

test.before(async () => {
    server = app.listen(0);
    await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    const address = server.address();
    baseUrl = "http://127.0.0.1:" + address.port;
});

test.after(async () => {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
});

test("production origin preflight is accepted without authentication", async () => {
    const response = await fetch(baseUrl + "/telegram/messages", {
        method: "OPTIONS",
        headers: {
            Origin: "https://hj-groups-website.getvoroa.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://hj-groups-website.getvoroa.com");
    assert.match(response.headers.get("access-control-allow-methods") || "", /(^|,\s*)GET(,|$)/i);
    assert.match(response.headers.get("access-control-allow-headers") || "", /(^|,\s*)Authorization(,|$)/i);
});

test("allowed origin is preserved on authenticated API error responses", async () => {
    const response = await fetch(baseUrl + "/telegram/messages", {
        headers: {
            Origin: "https://hj-groups-website.getvoroa.com",
            Authorization: "Bearer invalid-test-token",
        },
    });

    assert.equal(response.status, 401);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://hj-groups-website.getvoroa.com");
});

test("untrusted origins do not receive an allow-origin header", async () => {
    const response = await fetch(baseUrl + "/telegram/messages", {
        method: "OPTIONS",
        headers: {
            Origin: "https://example.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
});

const fs = require("fs");
const serverSource = fs.readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");

test("media routes advertise range support and route-aware MIME handling", () => {
    assert.match(serverSource, /function inferMediaMimeType\(targetMessage, routeKind = ['\"]audio['\"]\)/);
    assert.match(serverSource, /setHeader\('Accept-Ranges', 'bytes'\)/);
    assert.match(serverSource, /Content-Range/);
    assert.match(serverSource, /res\.status\(206\)/);
    assert.match(serverSource, /Telegram media stream ended before the requested byte range completed/);
});

test("media endpoints return controlled 404/5xx responses instead of HTTP 200 error bodies", () => {
    assert.match(serverSource, /if \(!targetMessage \|\| !targetMessage\.file\) return res\.status\(404\)/);
    assert.match(serverSource, /res\.status\(502\)\.json\(\{ error: 'Telegram media could not be streamed\.' \}\)/);
});


test("Unicode Telegram filenames are encoded safely for Node response headers", () => {
    assert.match(serverSource, /filename\*=UTF-8/)
    assert.match(serverSource, /encodeURIComponent\(rawName\)/)
    assert.match(serverSource, /asciiName = rawName/)
    assert.match(serverSource, /replace\(\/\[\^\\x20-\\x7E\]\/g, '_'\)/)
});


test("byte-range parser accepts browser audio ranges and rejects unsatisfiable ranges", () => {
    const { parseByteRange } = app;
    assert.deepEqual(parseByteRange("bytes=0-", 1000), {
        start: 0,
        end: 999,
        partial: true,
    });
    assert.deepEqual(parseByteRange("bytes=128-255", 1000), {
        start: 128,
        end: 255,
        partial: true,
    });
    assert.deepEqual(parseByteRange("bytes=950-1200", 1000), {
        start: 950,
        end: 999,
        partial: true,
    });
    assert.equal(parseByteRange("bytes=1000-", 1000).error, "unsatisfiable");
    assert.equal(parseByteRange("bytes=abc-", 1000).error, "invalid-range");
    assert.equal(parseByteRange("", 1000).partial, false);
});
