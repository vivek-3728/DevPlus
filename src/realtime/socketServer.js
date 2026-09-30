const { Server } = require("socket.io");
const projectService = require("../services/projectService");
const { getSecurityConfig } = require("../config/security");
const { verifyJwtIdentity } = require("../utils/jwtIdentity");
const { getErrorLogMessage } = require("../utils/errorDiagnostics");
const { logger: defaultLogger } = require("../utils/structuredLogger");
const {
    ADMIN_ROOM,
    projectRoom,
    userRoom,
    createProjectEventPublisher
} = require("./projectEvents");

const safeAcknowledge = (acknowledge, payload) => {
    if (typeof acknowledge === "function") acknowledge(payload);
};

const errorCodeFor = error => {
    if (error?.statusCode === 400) return "INVALID_REQUEST";
    if (error?.statusCode === 403) return "FORBIDDEN";
    if (error?.statusCode === 404) return "NOT_FOUND";
    return "INTERNAL_ERROR";
};

const createSocketServer = ({
    httpServer,
    env = process.env,
    logger = defaultLogger,
    authorizeProject = projectService.getProjectById,
    ServerClass = Server
}) => {
    if (!httpServer) throw new Error("An existing HTTP server is required for Socket.IO");
    const allowedOrigins = new Set(getSecurityConfig(env).allowedOrigins);

    // Socket.IO starts as an HTTP handshake and then upgrades to a persistent
    // transport. It attaches to the existing Express HTTP server; no second
    // port or competing server is created.
    const io = new ServerClass(httpServer, {
        serveClient: false,
        maxHttpBufferSize: 10_000,
        // CORS response headers protect browsers using HTTP polling. An
        // explicit handshake check also covers direct WebSocket transports,
        // which are not protected by browser CORS enforcement in the same way.
        allowRequest(request, callback) {
            const origin = request.headers.origin;
            callback(null, !origin || allowedOrigins.has(origin));
        },
        cors: {
            methods: ["GET", "POST"],
            origin(origin, callback) {
                callback(null, !origin || allowedOrigins.has(origin));
            }
        }
    });

    io.use((socket, next) => {
        try {
            // Tokens are accepted only through the Socket.IO auth object. They
            // are never placed in query strings or copied into logs.
            const actor = verifyJwtIdentity(socket.handshake.auth?.token);
            if (!new Set(["user", "admin"]).has(actor.role)) {
                throw new Error("Unsupported role");
            }
            socket.data.user = actor;
            next();
        } catch {
            logger.warn("socket.authentication_rejected", { socketId: socket.id });
            const error = new Error("Authentication failed");
            error.data = { code: "UNAUTHORIZED" };
            next(error);
        }
    });

    io.on("connection", socket => {
        const actor = socket.data.user;
        // Scope rooms make create/update/delete delivery private without
        // trusting any room name supplied by the client.
        socket.join(userRoom(actor.userId));
        if (actor.role === "admin") socket.join(ADMIN_ROOM);

        logger.info("socket.connected", {
            socketId: socket.id,
            userId: actor.userId,
            role: actor.role
        });

        socket.on("project:join", async (payload, acknowledge) => {
            try {
                const isExactPayload = payload !== null
                    && typeof payload === "object"
                    && !Array.isArray(payload)
                    && Object.keys(payload).length === 1
                    && Object.hasOwn(payload, "projectId");
                if (!isExactPayload) {
                    const error = new Error("Project ID is required");
                    error.statusCode = 400;
                    throw error;
                }

                // The service validates the ID, reads PostgreSQL/cache safely,
                // and applies the same owner/admin rule used by REST.
                const project = await authorizeProject(payload.projectId, actor);
                await socket.join(projectRoom(project.id));
                logger.info("socket.project_room_joined", {
                    socketId: socket.id,
                    userId: actor.userId,
                    projectId: project.id
                });
                safeAcknowledge(acknowledge, {
                    status: "joined",
                    projectId: project.id
                });
            } catch (error) {
                const code = errorCodeFor(error);
                const expected = code !== "INTERNAL_ERROR";
                logger[expected ? "warn" : "error"]("socket.project_room_rejected", {
                    socketId: socket.id,
                    userId: actor.userId,
                    code,
                    message: expected ? error.message : getErrorLogMessage(error)
                });
                safeAcknowledge(acknowledge, {
                    status: "error",
                    code,
                    message: expected ? error.message : "Unable to join project room"
                });
            }
        });

        socket.on("error", error => logger.warn("socket.connection_error", {
            socketId: socket.id,
            userId: actor.userId,
            message: getErrorLogMessage(error)
        }));

        socket.on("disconnect", reason => logger.info("socket.disconnected", {
            socketId: socket.id,
            userId: actor.userId,
            reason
        }));
    });

    io.engine?.on?.("connection_error", error => logger.warn("socket.transport_error", {
        code: error.code
    }));

    return {
        io,
        projectEventPublisher: createProjectEventPublisher(io)
    };
};

const closeSocketServer = io => new Promise(resolve => {
    if (!io) return resolve();
    io.close(() => resolve());
});

module.exports = { createSocketServer, closeSocketServer };
