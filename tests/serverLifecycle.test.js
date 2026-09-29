const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
    registerShutdownHandlers
} = require("../src/services/serverLifecycle");

test("shutdown closes HTTP, Redis, and PostgreSQL resources once", async () => {
    const processTarget = new EventEmitter();
    const calls = [];
    const lifecycle = registerShutdownHandlers({
        processTarget,
        server: {
            close: (callback) => {
                calls.push("http");
                callback();
            }
        },
        pool: { end: async () => { calls.push("postgres"); } },
        disconnectRedis: async () => { calls.push("redis"); },
        logger: { info: () => {}, error: () => {} },
        exit: (code) => { calls.push(`exit:${code}`); }
    });

    assert.equal(processTarget.listenerCount("SIGINT"), 1);
    assert.equal(processTarget.listenerCount("SIGTERM"), 1);

    await Promise.all([
        lifecycle.shutdown("SIGTERM"),
        lifecycle.shutdown("SIGINT")
    ]);

    assert.equal(calls.filter(value => value === "http").length, 1);
    assert.equal(calls.filter(value => value === "redis").length, 1);
    assert.equal(calls.filter(value => value === "postgres").length, 1);
    assert.deepEqual(calls.at(-1), "exit:0");
});

test("optional Redis cleanup failure does not prevent PostgreSQL cleanup", async () => {
    const calls = [];
    const errors = [];
    const lifecycle = registerShutdownHandlers({
        processTarget: new EventEmitter(),
        server: { close: (callback) => callback() },
        pool: { end: async () => { calls.push("postgres"); } },
        disconnectRedis: async () => { throw new Error("Redis cleanup failed"); },
        logger: {
            info: () => {},
            error: (...values) => errors.push(values)
        },
        exit: (code) => { calls.push(`exit:${code}`); }
    });

    await lifecycle.shutdown("SIGTERM");

    assert.deepEqual(calls, ["postgres", "exit:0"]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0][0], "server.shutdown_cleanup_failed");
    assert.deepEqual(errors[0][1], { message: "Redis cleanup failed" });
});

test("shutdown gives active requests a deadline before forcing HTTP close", async () => {
    const calls = [];
    const warnings = [];
    const lifecycle = registerShutdownHandlers({
        processTarget: new EventEmitter(),
        server: {
            close: () => { calls.push("stop-accepting"); },
            closeIdleConnections: () => { calls.push("close-idle"); },
            closeAllConnections: () => { calls.push("force-close"); }
        },
        pool: { end: async () => { calls.push("postgres"); } },
        disconnectRedis: async () => { calls.push("redis"); },
        shutdownTimeoutMs: 5,
        logger: {
            info: () => {},
            warn: (...values) => warnings.push(values),
            error: () => {}
        },
        exit: code => { calls.push(`exit:${code}`); }
    });

    await lifecycle.shutdown("SIGTERM");

    assert.deepEqual(calls, [
        "stop-accepting", "close-idle", "force-close", "redis", "postgres", "exit:0"
    ]);
    assert.deepEqual(warnings, [[
        "server.shutdown_http_timeout",
        { timeoutMs: 5 }
    ]]);
});
