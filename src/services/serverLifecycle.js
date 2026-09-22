const closeHttpServer = (server, logger) => new Promise(resolve => {
    try {
        server.close((error) => {
            if (error) logger.error("HTTP shutdown failed:", error.message);
            resolve();
        });
    } catch (error) {
        logger.error("HTTP shutdown failed:", error.message);
        resolve();
    }
});

const registerShutdownHandlers = ({
    processTarget = process,
    server,
    pool,
    disconnectRedis,
    logger = console,
    exit = code => process.exit(code)
}) => {
    let shutdownPromise;

    const shutdown = (signal) => {
        // SIGINT and SIGTERM can arrive close together. Reusing one Promise
        // prevents connections and the database pool from being closed twice.
        if (shutdownPromise) return shutdownPromise;

        shutdownPromise = (async () => {
            logger.log(`Received ${signal}; closing DevPulse resources`);
            await closeHttpServer(server, logger);

            // Redis is optional and PostgreSQL cleanup must still happen if its
            // disconnect fails, so cleanup tasks settle independently.
            const results = await Promise.allSettled([
                disconnectRedis(),
                pool.end()
            ]);
            for (const result of results) {
                if (result.status === "rejected") {
                    logger.error("Shutdown cleanup failed:", result.reason.message);
                }
            }

            exit(0);
        })();

        return shutdownPromise;
    };

    processTarget.once("SIGINT", () => { void shutdown("SIGINT"); });
    processTarget.once("SIGTERM", () => { void shutdown("SIGTERM"); });

    return { shutdown };
};

module.exports = { registerShutdownHandlers };
