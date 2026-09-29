const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../src/app");
const { createLogger } = require("../src/utils/structuredLogger");

const startApp = async ({ database, env = {}, records = [] }) => {
    const logger = createLogger({
        sink: { write: line => records.push(JSON.parse(line)) }
    });
    const app = createApp({
        database,
        logger,
        env: {
            NODE_ENV: "test",
            CORS_ALLOWED_ORIGINS: "http://localhost:5173",
            GENERAL_RATE_LIMIT_MAX: "100",
            AUTH_RATE_LIMIT_MAX: "100",
            ...env
        }
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(resolve => server.close(resolve))
    };
};

test("GET /health reports process liveness without checking dependencies", async (t) => {
    let databaseQueries = 0;
    const running = await startApp({
        database: { query: async () => { databaseQueries += 1; throw new Error("offline"); } }
    });
    t.after(running.close);

    const response = await fetch(`${running.baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "alive" });
    assert.equal(databaseQueries, 0);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/i);
});

test("GET /ready reports readiness when PostgreSQL answers", async (t) => {
    const queries = [];
    const running = await startApp({
        database: { query: async statement => { queries.push(statement); return { rows: [{ value: 1 }] }; } }
    });
    t.after(running.close);

    const response = await fetch(`${running.baseUrl}/ready`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ready" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(queries, [{ text: "SELECT 1", query_timeout: 2000 }]);
});

test("GET /ready returns a safe 503 when PostgreSQL is unavailable", async (t) => {
    const records = [];
    const running = await startApp({
        records,
        database: {
            query: async () => {
                throw new Error("password=private postgres://user:secret@db.internal/app");
            }
        }
    });
    t.after(running.close);

    const response = await fetch(`${running.baseUrl}/ready`);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "not ready" });
    const readinessLog = records.find(record => record.event === "readiness.postgres_unavailable");
    assert.equal(readinessLog.level, "warn");
    assert.equal(readinessLog.requestId, response.headers.get("x-request-id"));
    assert.equal(JSON.stringify(records).includes("private"), false);
    assert.equal(JSON.stringify(records).includes("secret"), false);
});

test("Redis configuration does not affect PostgreSQL readiness", async (t) => {
    const running = await startApp({
        env: { REDIS_URL: "not-a-valid-redis-url" },
        database: { query: async () => ({ rows: [{ value: 1 }] }) }
    });
    t.after(running.close);

    assert.equal((await fetch(`${running.baseUrl}/ready`)).status, 200);
});

test("health probes are not exhausted by the general API rate limit", async (t) => {
    const running = await startApp({
        env: { GENERAL_RATE_LIMIT_MAX: "1" },
        database: { query: async () => ({ rows: [{ value: 1 }] }) }
    });
    t.after(running.close);

    assert.equal((await fetch(`${running.baseUrl}/health`)).status, 200);
    assert.equal((await fetch(`${running.baseUrl}/health`)).status, 200);
    assert.equal((await fetch(`${running.baseUrl}/ready`)).status, 200);
    assert.equal((await fetch(`${running.baseUrl}/ready`)).status, 200);
});
