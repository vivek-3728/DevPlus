const { logger: defaultLogger } = require("../utils/structuredLogger");

const levelForStatus = (status) => {
    if (status >= 500) return "error";
    if (status >= 400) return "warn";
    return "info";
};

const createRequestLogger = ({ logger = defaultLogger, clock = Date.now } = {}) => {
    return (req, res, next) => {
        const start = clock();
        res.on("finish", () => {
            const level = levelForStatus(res.statusCode);
            logger[level]("http.request.completed", {
                method: req.method,
                // req.path excludes query strings and their sensitive values.
                path: req.path,
                status: res.statusCode,
                durationMs: Math.max(0, clock() - start)
            });
        });
        next();
    };
};

module.exports = createRequestLogger();
module.exports.createRequestLogger = createRequestLogger;
module.exports.levelForStatus = levelForStatus;
