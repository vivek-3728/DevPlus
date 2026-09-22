const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const userRepository = require("../src/repositories/userRepository");

// Save the real dependency functions so this test file can restore them when
// it finishes. The service itself remains real; only bcrypt and PostgreSQL data
// access are replaced because they are external boundaries of the service.
const originalHash = bcrypt.hash;
const originalFindByEmail = userRepository.findByEmail;
const originalCreateUser = userRepository.createUser;

let existingUser;
let events;

beforeEach(() => {
    existingUser = undefined;
    events = [];

    userRepository.findByEmail = async (email) => {
        events.push(["findByEmail", email]);
        return existingUser;
    };

    bcrypt.hash = async (password, saltRounds) => {
        events.push(["hash", password, saltRounds]);
        return "generated-password-hash";
    };

    userRepository.createUser = async (name, email, passwordHash) => {
        events.push(["createUser", name, email, passwordHash]);
        return {
            id: 12,
            name,
            email,
            role: "user",
            created_at: "2026-09-16T00:00:00.000Z"
        };
    };
});

after(() => {
    bcrypt.hash = originalHash;
    userRepository.findByEmail = originalFindByEmail;
    userRepository.createUser = originalCreateUser;
});

// Loading this module fails during the TDD red step because the service does
// not exist yet. After implementation, these tests exercise its real behavior.
const authService = require("../src/services/authService");

for (const [description, name, email, password] of [
    ["name", undefined, "learner@example.com", "secret123"],
    ["email", "Learner", undefined, "secret123"],
    ["password", "Learner", "learner@example.com", undefined]
]) {
    test(`registration rejects a missing ${description}`, async () => {
        await assert.rejects(
            authService.registerUser(name, email, password),
            error => {
                assert.equal(error.message, "Name, email and password are required");
                assert.equal(error.statusCode, 400);
                assert.equal(error.isOperational, true);
                return true;
            }
        );

        // Validation happens before database access or password hashing.
        assert.deepEqual(events, []);
    });
}

test("registration rejects an email that already belongs to a user", async () => {
    existingUser = {
        id: 4,
        name: "Existing User",
        email: "existing@example.com",
        password_hash: "stored-hash",
        role: "user",
        created_at: "2026-09-15T00:00:00.000Z"
    };

    await assert.rejects(
        authService.registerUser("New Name", "existing@example.com", "secret123"),
        error => {
            assert.equal(error.message, "User with this email already exists");
            assert.equal(error.statusCode, 409);
            return true;
        }
    );

    // Once the duplicate is found, no password is hashed and no row is created.
    assert.deepEqual(events, [["findByEmail", "existing@example.com"]]);
});

test("registration hashes the password and creates a safe user", async () => {
    const user = await authService.registerUser(
        "New User",
        "new@example.com",
        "plain-text-password"
    );

    assert.deepEqual(events, [
        ["findByEmail", "new@example.com"],
        ["hash", "plain-text-password", 10],
        ["createUser", "New User", "new@example.com", "generated-password-hash"]
    ]);
    assert.deepEqual(user, {
        id: 12,
        name: "New User",
        email: "new@example.com",
        role: "user",
        created_at: "2026-09-16T00:00:00.000Z"
    });
    assert.equal(Object.hasOwn(user, "password_hash"), false);
});
