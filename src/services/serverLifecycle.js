const { getErrorLogMessage } = require("../utils/errorDiagnostics");
const { logger: applicationLogger } = require("../utils/structuredLogger");

const closeHttpServer = (server, logger, timeoutMs) => new Promise(resolve => {
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve();
    };

    // server.close() immediately stops new connections and waits for active
    // responses. The deadline prevents a stuck client from blocking shutdown
    // forever; only after it expires are remaining connections force-closed.
    const timeout = setTimeout(() => {
        logger.warn("server.shutdown_http_timeout", { timeoutMs });
        try {
            server.closeAllConnections?.();
        } catch (error) {
            logger.error("server.shutdown_http_force_close_failed", {
                message: getErrorLogMessage(error)
            });
        } finally {
            finish();
        }
    }, timeoutMs);
    timeout.unref?.();

    try {
        server.close((error) => {
            if (error) logger.error("server.shutdown_http_failed", {
                message: getErrorLogMessage(error)
            });
            finish();
        });
    } catch (error) {
        logger.error("server.shutdown_http_failed", {
            message: getErrorLogMessage(error)
        });
        finish();
    }

    try {
        server.closeIdleConnections?.();
    } catch (error) {
        // Failure to close an idle socket must not skip the grace period for
        // active requests. The timeout remains responsible for final cleanup.
        logger.error("server.shutdown_http_idle_close_failed", {
            message: getErrorLogMessage(error)
        });
    }
});

const registerShutdownHandlers = ({
    processTarget = process,
    server,
    pool,
    disconnectRedis,
    shutdownTimeoutMs = 10000,
    logger = applicationLogger,
    exit = code => process.exit(code)
}) => {
    let shutdownPromise;

    const shutdown = (signal) => {
        // SIGINT and SIGTERM can arrive close together. Reusing one Promise
        // prevents connections and the database pool from being closed twice.
        if (shutdownPromise) return shutdownPromise;

        shutdownPromise = (async () => {
            logger.info("server.shutdown_started", { signal });
            await closeHttpServer(server, logger, shutdownTimeoutMs);
            logger.info("server.shutdown_http_closed");

            // Redis is optional and PostgreSQL cleanup must still happen if its
            // disconnect fails, so cleanup tasks settle independently.
            const results = await Promise.allSettled([
                disconnectRedis(),
                pool.end()
            ]);
            for (const result of results) {
                if (result.status === "rejected") {
                    logger.error("server.shutdown_cleanup_failed", {
                        message: getErrorLogMessage(result.reason)
                    });
                }
            }

            logger.info("server.shutdown_complete");
            exit(0);
        })();

        return shutdownPromise;
    };

    processTarget.once("SIGINT", () => { void shutdown("SIGINT"); });
    processTarget.once("SIGTERM", () => { void shutdown("SIGTERM"); });

    return { shutdown };
};

module.exports = { registerShutdownHandlers, closeHttpServer };
