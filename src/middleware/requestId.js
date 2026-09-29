const { randomUUID } = require("node:crypto");
const { runWithRequestContext } = require("../utils/requestContext");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const createRequestIdMiddleware = ({ generateId = randomUUID } = {}) => {
    return (req, res, next) => {
        const candidate = generateId();
        const requestId = UUID_PATTERN.test(candidate) ? candidate : randomUUID();

        // DevPulse generates this value itself. Arbitrary incoming IDs are not
        // trusted, preventing log injection and false cross-request correlation.
        req.requestId = requestId;
        res.setHeader("X-Request-ID", requestId);
        runWithRequestContext({ requestId }, next);
    };
};

module.exports = { createRequestIdMiddleware };
