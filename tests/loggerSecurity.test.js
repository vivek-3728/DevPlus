const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createRequestLogger } = require("../src/middleware/logger");

test("request logging excludes query-string credentials", () => {
    const req = {
        method: "GET",
        path: "/api/health",
        url: "/api/health?token=signed.jwt.value&password=secret"
    };
    const res = new EventEmitter();
    res.statusCode = 200;
    const messages = [];
    const logger = {
        info: (event, fields) => messages.push({ event, fields }),
        warn: (event, fields) => messages.push({ event, fields }),
        error: (event, fields) => messages.push({ event, fields })
    };

    createRequestLogger({ logger })(req, res, () => {});
    res.emit("finish");

    assert.equal(messages.length, 1);
    assert.equal(messages[0].event, "http.request.completed");
    assert.equal(messages[0].fields.method, "GET");
    assert.equal(messages[0].fields.path, "/api/health");
    assert.equal(messages[0].fields.status, 200);
    assert.equal(Number.isFinite(messages[0].fields.durationMs), true);
    const rendered = JSON.stringify(messages);
    assert.equal(rendered.includes("signed.jwt.value"), false);
    assert.equal(rendered.includes("secret"), false);
});
