const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../src/app");
const { createLogger } = require("../src/utils/structuredLogger");

const fixedRequestIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333"
];

const startApp = async () => {
    const records = [];
    let requestIdIndex = 0;
    const logger = createLogger({
        sink: { write: line => records.push(JSON.parse(line)) },
        clock: () => new Date("2026-09-29T10:00:00.000Z")
    });
    const app = createApp({
        env: {
            NODE_ENV: "test",
            CORS_ALLOWED_ORIGINS: "http://localhost:5173",
            GENERAL_RATE_LIMIT_MAX: "100",
            AUTH_RATE_LIMIT_MAX: "100"
        },
        logger,
        requestIdFactory: () => fixedRequestIds[requestIdIndex++],
        configureRoutes: app => {
            app.get("/__unexpected", () => {
                throw new Error("database password=private SQL details");
            });
        }
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    return {
        records,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(resolve => server.close(resolve))
    };
};

test("the default request ID generator returns a UUID", async (t) => {
    const app = createApp({
        env: {
            NODE_ENV: "test",
            CORS_ALLOWED_ORIGINS: "http://localhost:5173",
            GENERAL_RATE_LIMIT_MAX: "100",
            AUTH_RATE_LIMIT_MAX: "100"
        },
        requestLogger: (req, res, next) => next()
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    assert.match(
        response.headers.get("x-request-id"),
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
});

test("each request gets a server-owned ID in its response and completion log", async (t) => {
    const running = await startApp();
    t.after(running.close);

    const response = await fetch(`${running.baseUrl}/api/health?token=must-not-log`, {
        headers: { "X-Request-ID": "attacker-controlled-value" }
    });
    await response.text();

    assert.equal(
        response.headers.get("x-request-id"),
        "11111111-1111-4111-8111-111111111111"
    );
    const completion = running.records.find(record => record.event === "http.request.completed");
    assert.deepEqual(completion, {
        timestamp: "2026-09-29T10:00:00.000Z",
        level: "info",
        event: "http.request.completed",
        requestId: "11111111-1111-4111-8111-111111111111",
        method: "GET",
        path: "/api/health",
        status: 200,
        durationMs: completion.durationMs
    });
    assert.equal(Number.isFinite(completion.durationMs), true);
    assert.equal(JSON.stringify(running.records).includes("must-not-log"), false);
    assert.equal(JSON.stringify(running.records).includes("attacker-controlled-value"), false);
});

test("unexpected errors and their completion log share one request ID", async (t) => {
    const running = await startApp();
    t.after(running.close);

    const response = await fetch(`${running.baseUrl}/__unexpected`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Internal Server Error" });

    const requestId = response.headers.get("x-request-id");
    const errorRecord = running.records.find(record => record.event === "http.request.error");
    const completion = running.records.find(record => record.event === "http.request.completed");
    assert.equal(errorRecord.level, "error");
    assert.equal(errorRecord.requestId, requestId);
    assert.equal(errorRecord.status, 500);
    assert.equal(errorRecord.method, "GET");
    assert.equal(errorRecord.path, "/__unexpected");
    assert.equal(errorRecord.errorType, "Error");
    assert.ok(errorRecord.stack);
    assert.equal(JSON.stringify(errorRecord).includes("private"), false);
    assert.equal(completion.requestId, requestId);
    assert.equal(completion.level, "error");
});

test("expected operational errors log as warnings rather than unexpected failures", async (t) => {
    const running = await startApp();
    t.after(running.close);

    const response = await fetch(`${running.baseUrl}/api/projects`);
    assert.equal(response.status, 401);

    const errorRecord = running.records.find(record => record.event === "http.request.error");
    assert.equal(errorRecord.level, "warn");
    assert.equal(errorRecord.operational, true);
    assert.equal(errorRecord.status, 401);
    assert.equal(errorRecord.stack, undefined);
    assert.equal(errorRecord.requestId, response.headers.get("x-request-id"));
    const completion = running.records.find(record => record.event === "http.request.completed");
    assert.equal(completion.level, "warn");
    assert.equal(completion.requestId, errorRecord.requestId);
});
