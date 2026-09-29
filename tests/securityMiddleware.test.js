const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../src/app");

const startApp = async (overrides = {}) => {
    const app = createApp({
        env: {
            NODE_ENV: "test",
            CORS_ALLOWED_ORIGINS: "http://localhost:5173,https://frontend.example.com",
            GENERAL_RATE_LIMIT_WINDOW_MS: "60000",
            GENERAL_RATE_LIMIT_MAX: "100",
            AUTH_RATE_LIMIT_WINDOW_MS: "60000",
            AUTH_RATE_LIMIT_MAX: "10",
            REQUEST_BODY_LIMIT: "100kb",
            ...overrides
        },
        // Request logging is tested separately. Silence it here so security
        // assertions are easy to read and do not depend on console output.
        requestLogger: (req, res, next) => next()
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(resolve => server.close(resolve))
    };
};

test("responses include Helmet security headers without exposing Express", async (t) => {
    const running = await startApp();
    t.after(running.close);

    const response = await fetch(`${running.baseUrl}/api/health`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.ok(response.headers.get("content-security-policy"));
    assert.equal(response.headers.get("x-powered-by"), null);
});

test("CORS allows configured browser origins and requests without an Origin header", async (t) => {
    const running = await startApp();
    t.after(running.close);

    const browserResponse = await fetch(`${running.baseUrl}/api/health`, {
        headers: { Origin: "https://frontend.example.com" }
    });
    assert.equal(browserResponse.status, 200);
    assert.equal(
        browserResponse.headers.get("access-control-allow-origin"),
        "https://frontend.example.com"
    );

    const serverToServerResponse = await fetch(`${running.baseUrl}/api/health`);
    assert.equal(serverToServerResponse.status, 200);
});

test("allowed CORS preflight returns the configured origin", async (t) => {
    const running = await startApp();
    t.after(running.close);

    const response = await fetch(`${running.baseUrl}/api/projects`, {
        method: "OPTIONS",
        headers: {
            Origin: "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization"
        }
    });

    assert.equal(response.status, 204);
    assert.equal(
        response.headers.get("access-control-allow-origin"),
        "http://localhost:5173"
    );
    assert.match(
        response.headers.get("access-control-allow-headers"),
        /authorization/i
    );
});

test("CORS rejects an unconfigured browser origin with a safe 403", async (t) => {
    const running = await startApp();
    t.after(running.close);

    const response = await fetch(`${running.baseUrl}/api/health`, {
        headers: { Origin: "https://attacker.example.com" }
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Origin not allowed by CORS" });
    assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("production without an origin allow-list defaults closed", async (t) => {
    const running = await startApp({
        NODE_ENV: "production",
        CORS_ALLOWED_ORIGINS: ""
    });
    t.after(running.close);

    const response = await fetch(`${running.baseUrl}/api/health`, {
        headers: { Origin: "http://localhost:5173" }
    });

    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("denied CORS traffic still consumes the general rate limit", async (t) => {
    const running = await startApp({ GENERAL_RATE_LIMIT_MAX: "1" });
    t.after(running.close);
    const options = { headers: { Origin: "https://attacker.example.com" } };

    assert.equal((await fetch(`${running.baseUrl}/api/health`, options)).status, 403);
    assert.equal((await fetch(`${running.baseUrl}/api/health`, options)).status, 429);
});

test("oversized JSON and URL-encoded bodies return a safe 413 response", async (t) => {
    const running = await startApp({ REQUEST_BODY_LIMIT: "100b" });
    t.after(running.close);
    const largeValue = "x".repeat(200);

    for (const request of [
        {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: largeValue })
        },
        {
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ name: largeValue }).toString()
        }
    ]) {
        const response = await fetch(`${running.baseUrl}/api/auth/register`, {
            method: "POST",
            ...request
        });
        assert.equal(response.status, 413);
        assert.deepEqual(await response.json(), { error: "Request body is too large" });
    }
});

test("general API traffic returns 429 after its configured limit", async (t) => {
    const running = await startApp({ GENERAL_RATE_LIMIT_MAX: "2" });
    t.after(running.close);

    assert.equal((await fetch(`${running.baseUrl}/api/health`)).status, 200);
    assert.equal((await fetch(`${running.baseUrl}/api/health`)).status, 200);
    const blocked = await fetch(`${running.baseUrl}/api/health`);

    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), {
        error: "Too many requests, please try again later"
    });
    assert.ok(blocked.headers.get("ratelimit"));
});

test("login and register share a stricter authentication limit", async (t) => {
    const running = await startApp({ AUTH_RATE_LIMIT_MAX: "1" });
    t.after(running.close);

    const first = await fetch(`${running.baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
    });
    assert.equal(first.status, 400);

    const blocked = await fetch(`${running.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
    });
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), {
        error: "Too many authentication attempts, please try again later"
    });
});

test("malformed authentication bodies still consume the stricter limit", async (t) => {
    const running = await startApp({ AUTH_RATE_LIMIT_MAX: "1" });
    t.after(running.close);
    const request = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{"
    };

    assert.equal(
        (await fetch(`${running.baseUrl}/api/auth/login`, request)).status,
        400
    );
    assert.equal(
        (await fetch(`${running.baseUrl}/api/auth/register`, request)).status,
        429
    );
});

test("an explicit trusted-proxy hop keeps different forwarded clients separate", async (t) => {
    const running = await startApp({
        TRUST_PROXY_HOPS: "1",
        GENERAL_RATE_LIMIT_MAX: "1"
    });
    t.after(running.close);

    const first = await fetch(`${running.baseUrl}/api/health`, {
        headers: { "X-Forwarded-For": "203.0.113.10" }
    });
    const second = await fetch(`${running.baseUrl}/api/health`, {
        headers: { "X-Forwarded-For": "203.0.113.11" }
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
});

