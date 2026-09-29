const { checkPostgresReadiness } = require("../services/healthService");
const { getErrorLogMessage } = require("../utils/errorDiagnostics");

const createHealthController = ({ database, logger, readinessTimeoutMs }) => ({
    liveness(req, res) {
        // Liveness answers only whether this Node.js process can handle HTTP.
        // It deliberately performs no network or database work.
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json({ status: "alive" });
    },

    async readiness(req, res) {
        // A proxy must not reuse an older healthy result during a new outage.
        res.setHeader("Cache-Control", "no-store");
        try {
            await checkPostgresReadiness(database, readinessTimeoutMs);
            return res.status(200).json({ status: "ready" });
        } catch (error) {
            // Readiness failures are expected during database outages. Log a
            // redacted diagnostic internally and send no driver details out.
            logger.warn("readiness.postgres_unavailable", {
                dependency: "postgres",
                message: getErrorLogMessage(error)
            });
            return res.status(503).json({ status: "not ready" });
        }
    }
});

module.exports = { createHealthController };
