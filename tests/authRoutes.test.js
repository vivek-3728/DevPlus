const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bcrypt = require("bcrypt");
const userRepository = require("../src/repositories/userRepository");
const errorHandler = require("../src/middleware/errorHandler");

// Preserve the real external dependencies so they can be restored after these
// HTTP tests. The router, controller, service, and error middleware remain real.
const originalHash = bcrypt.hash;
const originalFindByEmail = userRepository.findByEmail;
const originalCreateUser = userRepository.createUser;

let server;
let baseUrl;
let existingUser;
let createdUser;

before(async () => {
    const authRoutes = require("../src/routes/authRoutes");
    const app = express();

    // Match the real application order: parse JSON, mount the router, then let
    // the centralized error middleware handle forwarded errors.
    app.use(express.json());
    app.use("/api/auth", authRoutes);
    app.use(errorHandler);

    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/auth/register`;
});

beforeEach(() => {
    existingUser = undefined;
    createdUser = {
        id: 20,
        name: "API Learner",
        email: "learner@example.com",
        role: "user",
        created_at: "2026-09-16T00:00:00.000Z"
    };

    userRepository.findByEmail = async () => existingUser;
    bcrypt.hash = async () => "generated-password-hash";
    userRepository.createUser = async () => createdUser;
});

after(async () => {
    bcrypt.hash = originalHash;
    userRepository.findByEmail = originalFindByEmail;
    userRepository.createUser = originalCreateUser;
    // Setup can fail during the TDD red step while authRoutes does not exist.
    // Only close the listener if setup reached the point where it was created.
    if (server) {
        await new Promise(resolve => server.close(resolve));
    }
});

const postRegistration = body => fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
});

test("POST /api/auth/register creates a user with status 201", async () => {
    const response = await postRegistration({
        name: "API Learner",
        email: "learner@example.com",
        password: "plain-text-password"
    });

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
        message: "User registered successfully",
        user: createdUser
    });
});

test("POST /api/auth/register returns 400 when required data is missing", async () => {
    const response = await postRegistration({
        name: "API Learner",
        email: "learner@example.com"
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
        error: "Name, email and password are required"
    });
});

test("POST /api/auth/register returns 409 for a duplicate email", async () => {
    existingUser = {
        id: 4,
        name: "Existing User",
        email: "learner@example.com",
        password_hash: "stored-hash",
        role: "user",
        created_at: "2026-09-15T00:00:00.000Z"
    };

    const response = await postRegistration({
        name: "API Learner",
        email: "learner@example.com",
        password: "plain-text-password"
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
        error: "User with this email already exists"
    });
});

test("registration response never exposes password fields", async () => {
    // Include sensitive fields in the fake repository result to verify that the
    // HTTP response remains safe even if a lower layer accidentally adds them.
    createdUser = {
        ...createdUser,
        password: "plain-text-password",
        password_hash: "generated-password-hash",
        internal_note: "must-not-leak"
    };

    const response = await postRegistration({
        name: "API Learner",
        email: "learner@example.com",
        password: "plain-text-password"
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(Object.hasOwn(body.user, "password"), false);
    assert.equal(Object.hasOwn(body.user, "password_hash"), false);
    assert.equal(Object.hasOwn(body.user, "internal_note"), false);
});
