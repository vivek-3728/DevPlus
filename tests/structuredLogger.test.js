const test = require("node:test");
const assert = require("node:assert/strict");

const { createLogger } = require("../src/utils/structuredLogger");
const { runWithRequestContext } = require("../src/utils/requestContext");

const createCapture = () => {
    const lines = [];
    return {
        lines,
        sink: { write: line => lines.push(JSON.parse(line)) }
    };
};

test("structured logger emits machine-readable level, event, time and fields", () => {
    const capture = createCapture();
    const logger = createLogger({
        sink: capture.sink,
        clock: () => new Date("2026-09-29T10:00:00.000Z")
    });

    logger.info("server.started", { port: 5000 });

    assert.deepEqual(capture.lines, [{
        timestamp: "2026-09-29T10:00:00.000Z",
        level: "info",
        event: "server.started",
        port: 5000
    }]);
});

test("logger automatically includes the current request ID", () => {
    const capture = createCapture();
    const logger = createLogger({ sink: capture.sink });

    runWithRequestContext({ requestId: "11111111-1111-4111-8111-111111111111" }, () => {
        logger.warn("cache.unavailable", { cache: "redis" });
    });

    assert.equal(capture.lines[0].requestId, "11111111-1111-4111-8111-111111111111");
    assert.equal(capture.lines[0].level, "warn");
});

test("logger redacts nested secrets, headers, cookies and URL credentials", () => {
    const capture = createCapture();
    const logger = createLogger({ sink: capture.sink });

    logger.error("security.test", {
        password: "plain-password",
        password_hash: "hashed-password",
        token: "signed.jwt.value",
        authorization: "Bearer signed.jwt.value",
        cookie: "session=private",
        databaseUrl: "postgres://db-user:db-secret@db.internal/app",
        dbPassword: "database-password",
        clientSecret: "oauth-secret",
        apiKey: "private-api-key",
        nested: { redis_url: "redis://cache-user:cache-secret@cache.internal" },
        safe: "visible"
    });

    const serialized = JSON.stringify(capture.lines[0]);
    for (const secret of [
        "plain-password",
        "hashed-password",
        "signed.jwt.value",
        "session=private",
        "db-user",
        "db-secret",
        "database-password",
        "oauth-secret",
        "private-api-key",
        "cache-user",
        "cache-secret"
    ]) {
        assert.equal(serialized.includes(secret), false);
    }
    assert.equal(capture.lines[0].safe, "visible");
    assert.equal(capture.lines[0].password, "[REDACTED]");
});
