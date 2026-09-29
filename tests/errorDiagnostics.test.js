const test = require("node:test");
const assert = require("node:assert/strict");

const {
    getErrorLogDetails,
    getErrorLogMessage
} = require("../src/utils/errorDiagnostics");

test("development diagnostics redact credentials while retaining useful context", () => {
    const error = new Error(
        "Redis redis://cache-user:redis-secret@cache.internal failed; "
        + "DATABASE_URL=postgres://db-user:db-secret@db.internal/app "
        + "Authorization: Bearer signed.jwt.value "
        + "https://web-user:web-secret@example.com "
        + '{"password":"json-secret","JWT_SECRET":"jwt-secret"}'
    );
    error.code = "ECONNREFUSED";

    const details = getErrorLogDetails(error, { NODE_ENV: "development" });

    assert.equal(details.includes("cache-user"), false);
    assert.equal(details.includes("db-user"), false);
    assert.equal(details.includes("redis-secret"), false);
    assert.equal(details.includes("db-secret"), false);
    assert.equal(details.includes("signed.jwt.value"), false);
    assert.equal(details.includes("web-user"), false);
    assert.equal(details.includes("web-secret"), false);
    assert.equal(details.includes("json-secret"), false);
    assert.equal(details.includes("jwt-secret"), false);
    assert.equal(details.includes("ECONNREFUSED"), false);
    assert.equal(details.includes("cache.internal"), true);
    assert.equal(details.includes("[REDACTED]"), true);
});

test("production diagnostics expose classification but no arbitrary message", () => {
    const error = new Error("password=secret SQL SELECT private_table");
    error.code = "DATABASE_FAILURE";

    assert.deepEqual(getErrorLogDetails(error, { NODE_ENV: "production" }), {
        name: "Error",
        code: "DATABASE_FAILURE"
    });
    assert.equal(
        getErrorLogMessage(error, { NODE_ENV: "production" }),
        "DATABASE_FAILURE"
    );

    error.name = "password=secret";
    assert.deepEqual(getErrorLogDetails(error, { NODE_ENV: "production" }), {
        name: "Error",
        code: "DATABASE_FAILURE"
    });
});
