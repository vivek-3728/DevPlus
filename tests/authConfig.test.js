const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const authConfig = require("../src/config/auth");

const originalSecret = process.env.JWT_SECRET;
const originalExpiresIn = process.env.JWT_EXPIRES_IN;

afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    if (originalExpiresIn === undefined) delete process.env.JWT_EXPIRES_IN;
    else process.env.JWT_EXPIRES_IN = originalExpiresIn;
});

test("JWT configuration rejects a missing secret with a clear startup error", () => {
    delete process.env.JWT_SECRET;
    assert.throws(
        () => authConfig.validateJwtConfig(),
        /JWT_SECRET environment variable is required/
    );
});

test("JWT configuration defaults token expiration to one hour", () => {
    delete process.env.JWT_EXPIRES_IN;
    assert.equal(authConfig.getJwtExpiresIn(), "1h");
});

test("JWT configuration uses a supplied token expiration", () => {
    process.env.JWT_EXPIRES_IN = "15m";
    assert.equal(authConfig.getJwtExpiresIn(), "15m");
});

test("JWT configuration rejects an invalid supplied expiration", () => {
    process.env.JWT_SECRET = "private-test-secret";
    process.env.JWT_EXPIRES_IN = "forever";
    assert.throws(
        () => authConfig.validateJwtConfig(),
        /JWT_EXPIRES_IN must be a positive duration/
    );
});
