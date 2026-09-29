const express = require("express");
const { createRequestLogger } = require("./middleware/logger");
const { createErrorHandler } = require("./middleware/errorHandler");
const { createRequestIdMiddleware } = require("./middleware/requestId");
const { logger: defaultLogger } = require("./utils/structuredLogger");
const databasePool = require("./config/db");
const { createHealthController } = require("./controllers/healthController");
const { readReadinessTimeout } = require("./config/environment");
const projectRoutes = require("./routes/projectRoutes");
const authRoutes = require("./routes/authRoutes");
const { getSecurityConfig } = require("./config/security");
const {
    createHelmetMiddleware,
    createCorsMiddleware,
    createCorsRejectionMiddleware,
    createGeneralRateLimiter,
    createAuthRateLimiter
} = require("./middleware/security");

const createApp = ({
    env = process.env,
    logger = defaultLogger,
    database = databasePool,
    requestLogger,
    requestIdFactory,
    configureRoutes
} = {}) => {
    const app = express();
    const security = getSecurityConfig(env);

    // Leave this false for direct connections. When deployment adds a reverse
    // proxy, set the exact hop count so rate limiting uses the real client IP
    // without trusting spoofed forwarding headers from arbitrary clients.
    app.set("trust proxy", security.trustProxy);

    // Correlation runs first so security/parser failures also get one ID.
    app.use(createRequestIdMiddleware({ generateId: requestIdFactory }));
    app.use(requestLogger || createRequestLogger({ logger }));

    // Security middleware runs before parsers and routes so its headers and
    // policies also apply to validation errors and rejected requests.
    app.use(createHelmetMiddleware());
    app.use(createCorsMiddleware(security.allowedOrigins));
    app.use(createGeneralRateLimiter(security.generalRateLimit));
    app.use(createCorsRejectionMiddleware(security.allowedOrigins));

    const healthController = createHealthController({
        database,
        logger,
        readinessTimeoutMs: readReadinessTimeout(env.READINESS_TIMEOUT_MS)
    });
    app.get("/health", healthController.liveness);
    app.get("/ready", healthController.readiness);

    // Mount this before parsing so malformed and oversized authentication
    // attempts also consume the stricter login/registration allowance.
    const authLimiter = createAuthRateLimiter(security.authRateLimit);
    app.use(["/api/auth/login", "/api/auth/register"], authLimiter);

    // Both common form encodings receive the same small limit. DevPulse only
    // accepts compact project/authentication payloads, not file uploads.
    app.use(express.json({ limit: security.bodyLimit }));
    app.use(express.urlencoded({ extended: false, limit: security.bodyLimit }));
    app.use("/api/projects", projectRoutes);
    app.use("/api/auth", authRoutes);

    app.get("/api/health", (req, res) => {
        res.json({
            status: "ok",
            message: "DevPulse backend is running"
        });
    });

    if (configureRoutes) configureRoutes(app);

    // Express recognizes this as error middleware because it has four
    // parameters. It must remain after every parser and route.
    app.use(createErrorHandler({ logger, env }));
    return app;
};

module.exports = { createApp };
