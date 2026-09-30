const jwt = require("jsonwebtoken");
const AppError = require("../errors/Apperror");
const { getJwtSecret } = require("../config/auth");

/**
 * Verify a JWT and return only the identity fields DevPulse trusts.
 *
 * HTTP requests and Socket.IO connections call the same helper so real-time
 * authentication cannot slowly develop different rules from the REST API.
 */
const verifyJwtIdentity = (token) => {
    if (typeof token !== "string" || !token.trim()) {
        throw new AppError("Authentication token is required", 401);
    }

    try {
        const payload = jwt.verify(token.trim(), getJwtSecret());
        if (!Number.isSafeInteger(payload.userId) || payload.userId <= 0) {
            throw new Error("JWT identity is incomplete");
        }

        return { userId: payload.userId, role: payload.role };
    } catch {
        // One generic response avoids revealing whether a token was malformed,
        // expired, signed incorrectly, or contained an unsupported role.
        throw new AppError("Invalid or expired token", 401);
    }
};

module.exports = { verifyJwtIdentity };
