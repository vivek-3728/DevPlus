const { getErrorLogMessage } = require("../utils/errorDiagnostics");
const { logger: applicationLogger } = require("../utils/structuredLogger");

const closeHttpServer = (server, logger, timeoutMs) => new Promise(resolve => {
    // Socket.IO's close() also closes the HTTP server it is attached to. Avoid
    // a second close call and its harmless ERR_SERVER_NOT_RUNNING diagnostic.
    if (server.listening === false) return resolve();

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
    closeJobQueue = async () => {},
    closeRealtimeServer = async () => {},
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

            // Socket.IO owns long-lived upgraded connections. Close it first so
            // those clients do not keep the shared HTTP server alive forever.
            try {
                await closeRealtimeServer();
                logger.info("server.shutdown_realtime_closed");
            } catch (error) {
                logger.error("server.shutdown_realtime_failed", {
                    message: getErrorLogMessage(error)
                });
            }

            await closeHttpServer(server, logger, shutdownTimeoutMs);
            logger.info("server.shutdown_http_closed");

            // BullMQ's Queue wrapper shares the API cache connection. Close
            // the wrapper first so it detaches listeners before Redis closes.
            try {
                await closeJobQueue();
            } catch (error) {
                logger.error("server.shutdown_queue_failed", {
                    message: getErrorLogMessage(error)
                });
            }

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

const registerWorkerShutdownHandlers = ({
    processTarget = process,
    worker,
    pool,
    disconnectRedis,
    shutdownTimeoutMs = 10000,
    logger = applicationLogger,
    exit = code => process.exit(code)
}) => {
    let shutdownPromise;

    const shutdown = signal => {
        // The worker entry point has no HTTP server, but uses the same signal
        // and Promise-deduplication pattern as the API lifecycle above.
        if (shutdownPromise) return shutdownPromise;
        shutdownPromise = (async () => {
            logger.info("worker.shutdown_started", { signal });

            let timeout;
            const gracefulClose = Promise.resolve()
                .then(() => worker.close())
                .catch(error => {
                    logger.error("worker.shutdown_close_failed", {
                        message: getErrorLogMessage(error)
                    });
                });
            const timedClose = new Promise(resolve => {
                timeout = setTimeout(async () => {
                    logger.warn("worker.shutdown_timeout", {
                        timeoutMs: shutdownTimeoutMs
                    });
                    try {
                        await worker.close(true);
                    } catch (error) {
                        logger.error("worker.shutdown_force_close_failed", {
                            message: getErrorLogMessage(error)
                        });
                    }
                    resolve();
                }, shutdownTimeoutMs);
                timeout.unref?.();
            });
            await Promise.race([gracefulClose, timedClose]);
            clearTimeout(timeout);

            const results = await Promise.allSettled([
                disconnectRedis(),
                pool.end()
            ]);
            for (const result of results) {
                if (result.status === "rejected") {
                    logger.error("worker.shutdown_cleanup_failed", {
                        message: getErrorLogMessage(result.reason)
                    });
                }
            }

            logger.info("worker.shutdown_complete");
            exit(0);
        })();
        return shutdownPromise;
    };

    processTarget.once("SIGINT", () => { void shutdown("SIGINT"); });
    processTarget.once("SIGTERM", () => { void shutdown("SIGTERM"); });
    return { shutdown };
};

module.exports = {
    registerShutdownHandlers,
    registerWorkerShutdownHandlers,
    closeHttpServer
};
