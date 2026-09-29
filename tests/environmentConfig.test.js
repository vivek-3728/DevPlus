const test = require("node:test");
const assert = require("node:assert/strict");

const { validateEnvironment } = require("../src/config/environment");

const validEnvironment = {
    NODE_ENV: "production",
    PORT: "5000",
    DB_USER: "devpulse",
    DB_HOST: "db.internal",
    DB_NAME: "devpulse",
    DB_PASSWORD: "private-database-password",
    DB_PORT: "5432",
    JWT_SECRET: "private-jwt-secret",
    CORS_ALLOWED_ORIGINS: "https://app.example.com",
    REQUEST_BODY_LIMIT: "100kb",
    GENERAL_RATE_LIMIT_WINDOW_MS: "900000",
    GENERAL_RATE_LIMIT_MAX: "100",
    AUTH_RATE_LIMIT_WINDOW_MS: "900000",
    AUTH_RATE_LIMIT_MAX: "10",
    TRUST_PROXY_HOPS: "1"
};

test("startup validation accepts required settings and optional Redis omission", () => {
    const config = validateEnvironment(validEnvironment);

    assert.equal(config.nodeEnv, "production");
    assert.equal(config.port, 5000);
    assert.equal(config.database.port, 5432);
    assert.equal(config.security.trustProxy, 1);
    assert.equal(Object.hasOwn(config, "redis"), false);
});

test("startup validation identifies every missing required setting without values", () => {
    for (const name of [
        "NODE_ENV", "DB_USER", "DB_HOST", "DB_NAME", "DB_PASSWORD",
        "DB_PORT", "JWT_SECRET"
    ]) {
        const env = { ...validEnvironment };
        delete env[name];
        assert.throws(() => validateEnvironment(env), new RegExp(`${name}.*required`));
    }
});

test("startup validation rejects invalid runtime and security settings", () => {
    for (const [name, value] of [
        ["NODE_ENV", "live"],
        ["PORT", "70000"],
        ["SHUTDOWN_TIMEOUT_MS", "999999"],
        ["READINESS_TIMEOUT_MS", "999999"],
        ["DB_PORT", "not-a-port"],
        ["REQUEST_BODY_LIMIT", "unlimited"],
        ["GENERAL_RATE_LIMIT_MAX", "0"],
        ["TRUST_PROXY_HOPS", "true"]
    ]) {
        assert.throws(
            () => validateEnvironment({ ...validEnvironment, [name]: value }),
            new RegExp(name)
        );
    }
});

test("configuration failures never include supplied secrets", () => {
    const secret = "do-not-print-this-value";
    assert.throws(
        () => validateEnvironment({
            ...validEnvironment,
            JWT_SECRET: secret,
            CORS_ALLOWED_ORIGINS: "https://example.com/path"
        }),
        error => {
            assert.equal(error.message.includes(secret), false);
            assert.equal(error.message.includes("private-database-password"), false);
            return true;
        }
    );
});
