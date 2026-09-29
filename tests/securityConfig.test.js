const test = require("node:test");
const assert = require("node:assert/strict");

const {
    getSecurityConfig
} = require("../src/config/security");

test("development defaults to the local React origin and production defaults closed", () => {
    assert.deepEqual(
        getSecurityConfig({ NODE_ENV: "development" }).allowedOrigins,
        ["http://localhost:5173"]
    );
    assert.deepEqual(
        getSecurityConfig({ NODE_ENV: "production" }).allowedOrigins,
        []
    );
});

test("configured CORS origins are trimmed, normalized, and deduplicated", () => {
    const config = getSecurityConfig({
        NODE_ENV: "production",
        CORS_ALLOWED_ORIGINS: " https://app.example.com/, http://localhost:5173,https://app.example.com "
    });

    assert.deepEqual(config.allowedOrigins, [
        "https://app.example.com",
        "http://localhost:5173"
    ]);
});

test("wildcard and non-origin CORS values are rejected", () => {
    assert.throws(
        () => getSecurityConfig({ CORS_ALLOWED_ORIGINS: "*" }),
        /must not contain a wildcard/
    );
    assert.throws(
        () => getSecurityConfig({ CORS_ALLOWED_ORIGINS: "https://example.com/path" }),
        /valid HTTP or HTTPS origins/
    );
});

test("security limits use safe defaults and accept positive integer overrides", () => {
    const defaults = getSecurityConfig({ NODE_ENV: "test" });
    assert.equal(defaults.bodyLimit, "100kb");
    assert.deepEqual(defaults.generalRateLimit, { windowMs: 900000, max: 100 });
    assert.deepEqual(defaults.authRateLimit, { windowMs: 900000, max: 10 });

    const configured = getSecurityConfig({
        NODE_ENV: "test",
        REQUEST_BODY_LIMIT: "2mb",
        GENERAL_RATE_LIMIT_WINDOW_MS: "1000",
        GENERAL_RATE_LIMIT_MAX: "25",
        AUTH_RATE_LIMIT_WINDOW_MS: "2000",
        AUTH_RATE_LIMIT_MAX: "3"
    });
    assert.equal(configured.bodyLimit, "2mb");
    assert.deepEqual(configured.generalRateLimit, { windowMs: 1000, max: 25 });
    assert.deepEqual(configured.authRateLimit, { windowMs: 2000, max: 3 });
    assert.equal(configured.trustProxy, false);
});

test("proxy trust requires an explicit positive hop count", () => {
    assert.equal(getSecurityConfig({ TRUST_PROXY_HOPS: "1" }).trustProxy, 1);
    assert.equal(getSecurityConfig({ TRUST_PROXY_HOPS: "2" }).trustProxy, 2);
    assert.equal(getSecurityConfig({ TRUST_PROXY_HOPS: "0" }).trustProxy, false);
    assert.equal(getSecurityConfig({ TRUST_PROXY_HOPS: "true" }).trustProxy, false);
});

test("zero or malformed body limits fall back instead of rejecting every body", () => {
    assert.equal(getSecurityConfig({ REQUEST_BODY_LIMIT: "0kb" }).bodyLimit, "100kb");
    assert.equal(getSecurityConfig({ REQUEST_BODY_LIMIT: "many" }).bodyLimit, "100kb");
});
