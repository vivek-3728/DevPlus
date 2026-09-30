const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");
const { io: createClient } = require("socket.io-client");

const AppError = require("../src/errors/Apperror");
const {
    createSocketServer,
    closeSocketServer
} = require("../src/realtime/socketServer");
const { projectRoom } = require("../src/realtime/projectEvents");

const TEST_SECRET = "socket-tests-private-secret";
const socketEnvironment = {
    NODE_ENV: "test",
    CORS_ALLOWED_ORIGINS: "http://localhost:5173"
};

const createTestLogger = () => {
    const records = [];
    return {
        records,
        logger: {
            info: (event, fields) => records.push({ level: "info", event, fields }),
            warn: (event, fields) => records.push({ level: "warn", event, fields }),
            error: (event, fields) => records.push({ level: "error", event, fields })
        }
    };
};

const startRealtimeServer = async ({ authorizeProject } = {}) => {
    process.env.JWT_SECRET = TEST_SECRET;
    const app = express();
    app.get("/health", (req, res) => res.json({ status: "alive" }));
    const httpServer = createServer(app);
    const logging = createTestLogger();
    const realtime = createSocketServer({
        httpServer,
        env: socketEnvironment,
        logger: logging.logger,
        authorizeProject
    });
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));

    return {
        ...realtime,
        ...logging,
        httpServer,
        url: `http://127.0.0.1:${httpServer.address().port}`,
        close: () => closeSocketServer(realtime.io)
    };
};

const tokenFor = actor => jwt.sign(actor, TEST_SECRET, { expiresIn: "5m" });

const connectClient = (url, actor, options = {}) => new Promise((resolve, reject) => {
    const client = createClient(url, {
        forceNew: true,
        reconnection: false,
        transports: ["websocket"],
        auth: actor ? { token: tokenFor(actor) } : {},
        ...options
    });
    client.once("connect", () => resolve(client));
    client.once("connect_error", reject);
});

const waitForEvent = (socket, eventName) => new Promise(resolve => {
    socket.once(eventName, resolve);
});

const joinProject = (socket, projectId) => new Promise(resolve => {
    socket.emit("project:join", { projectId }, resolve);
});

test("Socket.IO attaches to the existing HTTP server with the shared CORS policy", () => {
    const constructions = [];
    class FakeServer {
        constructor(server, options) {
            constructions.push({ server, options });
            this.engine = { on() {} };
        }
        use() {}
        on() {}
        to() { return this; }
        emit() {}
    }
    const httpServer = { one: "existing-server" };

    createSocketServer({
        httpServer,
        env: socketEnvironment,
        ServerClass: FakeServer,
        logger: createTestLogger().logger
    });

    assert.equal(constructions.length, 1);
    assert.equal(constructions[0].server, httpServer);
    assert.equal(constructions[0].options.serveClient, false);
    const originCheck = constructions[0].options.cors.origin;
    originCheck("http://localhost:5173", (error, allowed) => {
        assert.equal(error, null);
        assert.equal(allowed, true);
    });
    originCheck("https://untrusted.example", (error, allowed) => {
        assert.equal(error, null);
        assert.equal(allowed, false);
    });
    constructions[0].options.allowRequest(
        { headers: { origin: "https://untrusted.example" } },
        (error, allowed) => {
            assert.equal(error, null);
            assert.equal(allowed, false);
        }
    );
});

test("a valid JWT connects and disconnects with safe structured lifecycle logs", async (t) => {
    const running = await startRealtimeServer();
    t.after(running.close);
    const client = await connectClient(running.url, { userId: 31, role: "user" });

    assert.equal(client.connected, true);
    assert.ok(running.records.some(record => record.event === "socket.connected"
        && record.fields.userId === 31));
    assert.equal(JSON.stringify(running.records).includes(tokenFor({ userId: 31, role: "user" })), false);

    const disconnected = new Promise(resolve => {
        const check = () => {
            if (running.records.some(record => record.event === "socket.disconnected")) {
                resolve();
            } else {
                setImmediate(check);
            }
        };
        check();
    });
    client.close();
    await disconnected;
});

test("missing JWT and unsupported roles are rejected before connection", async (t) => {
    const running = await startRealtimeServer();
    t.after(running.close);

    for (const actor of [undefined, { userId: 8, role: "guest" }]) {
        const error = await new Promise(resolve => {
            const client = createClient(running.url, {
                forceNew: true,
                reconnection: false,
                transports: ["websocket"],
                auth: actor ? { token: tokenFor(actor) } : {}
            });
            client.once("connect_error", connectionError => {
                client.close();
                resolve(connectionError);
            });
        });
        assert.equal(error.message, "Authentication failed");
        assert.deepEqual(error.data, { code: "UNAUTHORIZED" });
    }
});

test("the shared CORS allow-list rejects an untrusted WebSocket origin", async (t) => {
    const running = await startRealtimeServer();
    t.after(running.close);
    const error = await new Promise(resolve => {
        const client = createClient(running.url, {
            forceNew: true,
            reconnection: false,
            transports: ["websocket"],
            auth: { token: tokenFor({ userId: 31, role: "user" }) },
            extraHeaders: { Origin: "https://untrusted.example" }
        });
        client.once("connect_error", connectionError => {
            client.close();
            resolve(connectionError);
        });
    });

    assert.ok(error instanceof Error);
    assert.equal(running.records.some(record => record.event === "socket.connected"), false);
});

test("project room joins reuse owner/admin authorization", async (t) => {
    const authorizeProject = async (id, actor) => {
        const project = { id: Number(id), owner_id: 31 };
        if (actor.role !== "admin" && actor.userId !== project.owner_id) {
            throw new AppError("Forbidden", 403);
        }
        return project;
    };
    const running = await startRealtimeServer({ authorizeProject });
    t.after(running.close);
    const owner = await connectClient(running.url, { userId: 31, role: "user" });
    const stranger = await connectClient(running.url, { userId: 44, role: "user" });
    t.after(() => { owner.close(); stranger.close(); });

    assert.deepEqual(await joinProject(owner, 42), { status: "joined", projectId: 42 });
    assert.equal(
        running.io.sockets.adapter.rooms.get(projectRoom(42))?.has(owner.id),
        true
    );
    assert.deepEqual(await joinProject(stranger, 42), {
        status: "error",
        code: "FORBIDDEN",
        message: "Forbidden"
    });
    assert.notEqual(
        running.io.sockets.adapter.rooms.get(projectRoom(42))?.has(stranger.id),
        true
    );
});

test("project events target only authorized owner/project/admin rooms", async (t) => {
    const project = {
        id: 42,
        name: "Realtime",
        environment: "production",
        owner_id: 31,
        password_hash: "must-not-leak",
        token: "must-not-leak"
    };
    const running = await startRealtimeServer({
        authorizeProject: async (id, actor) => {
            if (actor.role !== "admin" && actor.userId !== project.owner_id) {
                throw new AppError("Forbidden", 403);
            }
            return { ...project, id: Number(id) };
        }
    });
    t.after(running.close);
    const owner = await connectClient(running.url, { userId: 31, role: "user" });
    const stranger = await connectClient(running.url, { userId: 44, role: "user" });
    const admin = await connectClient(running.url, { userId: 1, role: "admin" });
    t.after(() => { owner.close(); stranger.close(); admin.close(); });
    await joinProject(owner, 42);

    const ownerEvent = waitForEvent(owner, "project:updated");
    const adminEvent = waitForEvent(admin, "project:updated");
    let strangerReceived = false;
    stranger.once("project:updated", () => { strangerReceived = true; });
    running.projectEventPublisher.updated(project, { requestId: "request-42" });

    const [ownerPayload, adminPayload] = await Promise.all([ownerEvent, adminEvent]);
    assert.deepEqual(ownerPayload, adminPayload);
    assert.deepEqual(ownerPayload, {
        project: {
            id: 42,
            name: "Realtime",
            environment: "production",
            owner_id: 31
        },
        requestId: "request-42"
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(strangerReceived, false);
});

test("created and deleted events use safe owner/admin-targeted payloads", async (t) => {
    const running = await startRealtimeServer();
    t.after(running.close);
    const owner = await connectClient(running.url, { userId: 31, role: "user" });
    const admin = await connectClient(running.url, { userId: 1, role: "admin" });
    t.after(() => { owner.close(); admin.close(); });
    const project = {
        id: 9,
        name: "New Project",
        environment: "development",
        owner_id: 31,
        password_hash: "hidden"
    };

    const created = waitForEvent(owner, "project:created");
    running.projectEventPublisher.created(project);
    assert.deepEqual(await created, {
        project: {
            id: 9,
            name: "New Project",
            environment: "development",
            owner_id: 31
        }
    });

    const deleted = waitForEvent(admin, "project:deleted");
    running.projectEventPublisher.deleted(project, { requestId: "delete-request" });
    assert.deepEqual(await deleted, {
        projectId: 9,
        requestId: "delete-request"
    });
});

test("Socket.IO shutdown disconnects active clients and closes the shared server", async () => {
    const running = await startRealtimeServer();
    const client = await connectClient(running.url, { userId: 31, role: "user" });
    const disconnected = waitForEvent(client, "disconnect");

    await running.close();
    await disconnected;

    assert.equal(client.connected, false);
    assert.equal(running.httpServer.listening, false);
});
