const { test } = require("node:test");
const assert = require("node:assert/strict");

test("authorizeRoles allows a configured role", () => {
    const authorizeRoles = require("../src/middleware/authorizeRoles");
    let nextError;

    authorizeRoles("user", "admin")(
        { user: { userId: 31, role: "user" } },
        {},
        (error) => { nextError = error; }
    );

    assert.equal(nextError, undefined);
});

test("authorizeRoles rejects missing and disallowed roles with 403", () => {
    const authorizeRoles = require("../src/middleware/authorizeRoles");

    for (const request of [{}, { user: { userId: 31, role: "guest" } }]) {
        let nextError;
        authorizeRoles("user", "admin")(request, {}, (error) => { nextError = error; });
        assert.equal(nextError.statusCode, 403);
        assert.equal(nextError.message, "Forbidden");
    }
});
