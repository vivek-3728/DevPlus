// Application entry point: run with node src/server.js from the project root.
// Request flow: JSON parser -> logger -> router -> controller -> service -> repository.
// Responses travel back to the controller; errors go to the final error middleware.
require("dotenv").config({ quiet: true });//load environment variables from .env file
const { createServer } = require("node:http");
const { logger } = require("./utils/structuredLogger");
const { validateEnvironment } = require("./config/environment");

// Validate critical settings before creating clients or opening a network port.
// Validation errors name variables but never include their secret values.
let startupConfig;
try {
    startupConfig = validateEnvironment(process.env);
} catch (error) {
    logger.error("server.configuration_invalid", { message: error.message });
    throw error;
}

const { createApp } = require("./app");
const { connectRedis, disconnectRedis } = require("./config/redis");
const { registerShutdownHandlers } = require("./services/serverLifecycle");
const pool = require("./config/db");
const { getErrorLogDetails } = require("./utils/errorDiagnostics");
const {
    closeProjectAnalyticsQueue
} = require("./queues/projectAnalyticsQueue");
const { createSocketServer, closeSocketServer } = require("./realtime/socketServer");

// The shared application factory installs security middleware, parsers, routes,
// and centralized error handling in one consistently tested order.
const app = createApp({ env: process.env, database: pool });
const server = createServer(app);
const { io, projectEventPublisher } = createSocketServer({
    httpServer: server,
    env: process.env,
    logger
});
app.set("projectEventPublisher", projectEventPublisher);

// Define the port number where the server will listen
const PORT = startupConfig.port;

// Start the Express server and listen for incoming connections on the specified PORT
server.listen(PORT, () => {
    logger.info("server.started", { port: Number(PORT) });
});

// Start Redis in the background instead of making HTTP startup depend on it.
// If Redis is absent, cache operations fail open and PostgreSQL serves reads.
connectRedis();

// Close network/database resources on the normal container/terminal shutdown
// signals. The helper deduplicates simultaneous signals and Redis remains
// optional even during cleanup.
registerShutdownHandlers({
    server,
    pool,
    disconnectRedis,
    closeJobQueue: closeProjectAnalyticsQueue,
    closeRealtimeServer: () => closeSocketServer(io),
    shutdownTimeoutMs: startupConfig.shutdownTimeoutMs
});

// This asynchronous database check runs after starting the HTTP listener.
// A failure is logged; it does not stop the server or change /api/health.
pool.query("SELECT NOW()")
    .then(() => {
        logger.info("postgres.connected");
    })
    .catch(error => {
        logger.error("postgres.connection_failed", {
            error: getErrorLogDetails(error)
        });
    });
