const cors = require("cors");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const AppError = require("../errors/Apperror");

const createHelmetMiddleware = () => {
    // Helmet's maintained defaults add common browser security headers. The
    // headers protect API responses and do not prevent an allowed React origin
    // from making normal CORS fetch requests.
    return helmet();
};

const createCorsMiddleware = (allowedOrigins) => {
    const allowed = new Set(allowedOrigins);
    return cors({
        // Browser code can show this ID in support messages and correlate it
        // with server logs without exposing any secret response headers.
        exposedHeaders: ["X-Request-ID"],
        origin(origin, callback) {
            // Browsers send Origin. Command-line tools, mobile apps, health
            // checks and server-to-server requests commonly do not.
            // A denied origin receives no CORS headers but continues to the
            // general limiter. A separate middleware returns its safe 403
            // after the request has consumed rate-limit capacity.
            return callback(null, !origin || allowed.has(origin));
        }
    });
};

const createCorsRejectionMiddleware = (allowedOrigins) => {
    const allowed = new Set(allowedOrigins);
    return (req, res, next) => {
        const origin = req.headers.origin;
        if (origin && !allowed.has(origin)) {
            return next(new AppError("Origin not allowed by CORS", 403));
        }
        next();
    };
};

const createLimiter = ({ windowMs, max }, message) => rateLimit({
    windowMs,
    limit: max,
    // Modern RateLimit headers let clients learn the active policy without
    // also sending the older X-RateLimit-* header family.
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // CORS preflight requests describe a future request and should not consume
    // the caller's application quota.
    // Infrastructure probes must not make the application appear unhealthy
    // merely because a monitoring system checks them frequently.
    skip: req => req.method === "OPTIONS"
        || req.path === "/health"
        || req.path === "/ready",
    handler: (req, res) => res.status(429).json({ error: message })
});

const createGeneralRateLimiter = (policy) => createLimiter(
    policy,
    "Too many requests, please try again later"
);

const createAuthRateLimiter = (policy) => createLimiter(
    policy,
    "Too many authentication attempts, please try again later"
);

module.exports = {
    createHelmetMiddleware,
    createCorsMiddleware,
    createCorsRejectionMiddleware,
    createGeneralRateLimiter,
    createAuthRateLimiter
};
