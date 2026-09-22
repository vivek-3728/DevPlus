const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const userRepository = require("../src/repositories/userRepository");
const errorHandler = require("../src/middleware/errorHandler");

// Tests use a known secret so real JWT signing and verification can be exercised
// without depending on a developer's private .env file.
const originalJwtSecret = process.env.JWT_SECRET;
const originalJwtExpiresIn = process.env.JWT_EXPIRES_IN;
process.env.JWT_SECRET = "test-only-jwt-secret-that-is-not-used-in-production";
process.env.JWT_EXPIRES_IN = "1h";

// Keep the application layers real and replace only slow/external boundaries.
const originalCompare = bcrypt.compare;
const originalFindByEmail = userRepository.findByEmail;
const originalFindById = userRepository.findById;

let server;
let baseUrl;
let existingUser;
let currentUser;
let passwordMatches;
let compareArguments;
let requestedUserId;

before(async () => {
    const authRoutes = require("../src/routes/authRoutes");
    const app = express();
    app.use(express.json());
    app.use("/api/auth", authRoutes);
    app.use(errorHandler);

    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/auth`;
});

beforeEach(() => {
    existingUser = {
        id: 31,
        name: "Login Learner",
        email: "login@example.com",
        password_hash: "stored-bcrypt-hash",
        role: "user",
        created_at: "2026-09-16T00:00:00.000Z"
    };
    currentUser = { ...existingUser, password: "must-not-leak" };
    passwordMatches = true;
    compareArguments = undefined;
    requestedUserId = undefined;

    userRepository.findByEmail = async () => existingUser;
    userRepository.findById = async userId => {
        requestedUserId = userId;
        return currentUser;
    };
    bcrypt.compare = async (plainPassword, storedHash) => {
        compareArguments = [plainPassword, storedHash];
        return passwordMatches;
    };
});

after(async () => {
    bcrypt.compare = originalCompare;
    userRepository.findByEmail = originalFindByEmail;
    if (originalFindById === undefined) {
        delete userRepository.findById;
    } else {
        userRepository.findById = originalFindById;
    }

    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
    if (originalJwtExpiresIn === undefined) delete process.env.JWT_EXPIRES_IN;
    else process.env.JWT_EXPIRES_IN = originalJwtExpiresIn;

    if (server) await new Promise(resolve => server.close(resolve));
});

const postLogin = body => fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
});

const getMe = token => fetch(`${baseUrl}/me`, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` }
});

test("successful login returns a safe user and a one-hour JWT", async () => {
    const response = await postLogin({
        email: "login@example.com",
        password: "plain-password"
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.message, "Login successful");
    assert.deepEqual(body.user, {
        id: 31,
        name: "Login Learner",
        email: "login@example.com",
        role: "user"
    });
    assert.equal(typeof body.token, "string");
    assert.deepEqual(compareArguments, ["plain-password", "stored-bcrypt-hash"]);

    const payload = jwt.verify(body.token, process.env.JWT_SECRET);
    assert.equal(payload.userId, 31);
    assert.equal(payload.role, "user");
    assert.equal(payload.exp - payload.iat, 3600);
    assert.equal(Object.hasOwn(payload, "email"), false);
    assert.equal(Object.hasOwn(payload, "password"), false);
    assert.equal(Object.hasOwn(payload, "password_hash"), false);
});

test("login rejects missing credentials with status 400", async () => {
    const response = await postLogin({ email: "login@example.com" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
        error: "Email and password are required"
    });
});

test("login rejects an unknown email with the generic 401 message", async () => {
    existingUser = undefined;
    const response = await postLogin({
        email: "unknown@example.com",
        password: "plain-password"
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
        error: "Invalid email or password"
    });
    // Unknown emails still perform one bcrypt comparison against a fixed dummy
    // hash so response timing is closer to the wrong-password path.
    assert.equal(compareArguments[0], "plain-password");
    assert.match(compareArguments[1], /^\$2[aby]\$10\$/);
});

test("login rejects a wrong password with the same generic 401 message", async () => {
    passwordMatches = false;
    const response = await postLogin({
        email: "login@example.com",
        password: "wrong-password"
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
        error: "Invalid email or password"
    });
});

test("GET /api/auth/me rejects a missing Bearer token", async () => {
    const response = await getMe();
    assert.equal(response.status, 401);
});

test("GET /api/auth/me rejects an invalid JWT", async () => {
    const response = await getMe("not-a-valid-jwt");
    assert.equal(response.status, 401);
});

test("GET /api/auth/me rejects an expired JWT", async () => {
    const expiredToken = jwt.sign(
        { userId: 31, role: "user" },
        process.env.JWT_SECRET,
        { expiresIn: -1 }
    );
    const response = await getMe(expiredToken);
    assert.equal(response.status, 401);
});

test("GET /api/auth/me uses a valid JWT and returns only safe user fields", async () => {
    const token = jwt.sign(
        { userId: 31, role: "user", ignoredValue: "not-copied-to-req-user" },
        process.env.JWT_SECRET,
        { expiresIn: "1h" }
    );
    const response = await getMe(token);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(requestedUserId, 31);
    assert.deepEqual(body, {
        user: {
            id: 31,
            name: "Login Learner",
            email: "login@example.com",
            role: "user"
        }
    });
    assert.equal(Object.hasOwn(body.user, "password"), false);
    assert.equal(Object.hasOwn(body.user, "password_hash"), false);
});

test("GET /api/auth/me returns 404 when the authenticated user no longer exists", async () => {
    currentUser = undefined;
    const token = jwt.sign(
        { userId: 31, role: "user" },
        process.env.JWT_SECRET,
        { expiresIn: "1h" }
    );
    const response = await getMe(token);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "User not found" });
});
