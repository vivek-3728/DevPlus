const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../src/config/db");
const userRepository = require("../src/repositories/userRepository");

const originalQuery = pool.query;

after(() => {
    pool.query = originalQuery;
});

test("findById retrieves only safe user columns with a parameterized query", async () => {
    let query;
    pool.query = async (sql, values) => {
        query = { sql: sql.replace(/\s+/g, " ").trim(), values };
        return {
            rows: [{
                id: 31,
                name: "Login Learner",
                email: "login@example.com",
                role: "user"
            }]
        };
    };

    const user = await userRepository.findById(31);

    assert.deepEqual(user, {
        id: 31,
        name: "Login Learner",
        email: "login@example.com",
        role: "user"
    });
    assert.deepEqual(query.values, [31]);
    assert.match(query.sql, /^SELECT id, name, email, role FROM users WHERE id = \$1$/i);
    assert.equal(query.sql.includes("password_hash"), false);
});
