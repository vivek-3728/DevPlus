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
        logger: { log: () => {}, error: () => {} },
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
            log: () => {},
            error: (...values) => errors.push(values)
        },
        exit: (code) => { calls.push(`exit:${code}`); }
    });

    await lifecycle.shutdown("SIGTERM");

    assert.deepEqual(calls, ["postgres", "exit:0"]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0][0], "Shutdown cleanup failed:");
});
