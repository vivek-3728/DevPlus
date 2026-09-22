const Apperror = require("../errors/Apperror");

/**
 * Build middleware that allows only the listed roles.
 *
 * Authentication proves who the caller is. Authorization is the separate
 * decision about what that authenticated caller is allowed to do.
 */
const authorizeRoles = (...allowedRoles) => (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
        return next(new Apperror("Forbidden", 403));
    }

    next();
};

module.exports = authorizeRoles;
