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
