// Alternate server file: it starts the same shared application as src/server.js.
// Run directly with node src/services/server.js; src/server.js does not import it.
// Both default to port 5000, so running both together on that port would conflict.
// Unlike src/server.js, this file does not run the SELECT NOW() database check.
// Load .env before reading PORT; the database pool still uses hardcoded settings.
require("dotenv").config({ quiet: true });
const { createServer } = require("node:http");
const { logger } = require("../utils/structuredLogger");
const { validateEnvironment } = require("../config/environment");

let startupConfig;
try {
    startupConfig = validateEnvironment(process.env);
} catch (error) {
    logger.error("server.configuration_invalid", { message: error.message });
    throw error;
}

const { createApp } = require("../app");
const pool = require("../config/db");
const { connectRedis, disconnectRedis } = require("../config/redis");
const { registerShutdownHandlers } = require("./serverLifecycle");
const {
    closeProjectAnalyticsQueue
} = require("../queues/projectAnalyticsQueue");
const { createSocketServer, closeSocketServer } = require("../realtime/socketServer");

const app = createApp({ env: process.env, database: pool });
const server = createServer(app);
const { io, projectEventPublisher } = createSocketServer({
    httpServer: server,
    env: process.env,
    logger
});
app.set("projectEventPublisher", projectEventPublisher);
// This is a separate Express application instance from the one in src/server.js.

const PORT = startupConfig.port;


// ======================================================
// START SERVER
// ======================================================

server.listen(PORT, () => {
    logger.info("server.started", { port: Number(PORT), entrypoint: "alternate" });
});

connectRedis();
registerShutdownHandlers({
    server,
    pool,
    disconnectRedis,
    closeJobQueue: closeProjectAnalyticsQueue,
    closeRealtimeServer: () => closeSocketServer(io),
    shutdownTimeoutMs: startupConfig.shutdownTimeoutMs
});
