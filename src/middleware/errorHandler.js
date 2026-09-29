const { getErrorLogDetails, redactSensitiveText } = require("../utils/errorDiagnostics");
const { logger: defaultLogger } = require("../utils/structuredLogger");

const classifyError = (err) => {
    if (err.type === "entity.too.large" || err.status === 413) {
        return { status: 413, message: "Request body is too large", operational: true };
    }
    if (err.type === "entity.parse.failed") {
        return { status: 400, message: "Invalid JSON payload", operational: true };
    }
    if (err.isOperational) {
        return { status: err.statusCode, message: err.message, operational: true };
    }
    return { status: 500, message: "Internal Server Error", operational: false };
};

const createErrorHandler = ({ logger = defaultLogger, env = process.env } = {}) => {
    return (err, req, res, next) => {
        const classification = classifyError(err);
        const details = getErrorLogDetails(err, env);
        const fields = {
            method: req.method,
            path: req.path,
            status: classification.status,
            operational: classification.operational,
            errorType: details.name || "Error"
        };

        if (classification.operational) {
            // Expected client/application failures are warnings, not crashes.
            fields.message = redactSensitiveText(classification.message);
            logger.warn("http.request.error", fields);
        } else {
            // Development keeps a redacted stack. Production retains only safe
            // classifications, preserving the production-safe error contract.
            if (env.NODE_ENV !== "production") {
                fields.message = redactSensitiveText(err.message || "Unexpected error");
                fields.stack = typeof details === "string" ? details : undefined;
            }
            if (details.code) fields.errorCode = details.code;
            logger.error("http.request.error", fields);
        }

        res.status(classification.status).json({ error: classification.message });
    };
};

module.exports = createErrorHandler();
module.exports.createErrorHandler = createErrorHandler;
module.exports.classifyError = classifyError;
