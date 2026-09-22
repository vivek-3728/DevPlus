// Import the authentication service, which contains registration business logic
// such as validation, duplicate-email checking, and password hashing.
const authService = require("../services/authService");

// Controllers handle the HTTP part of a request. They read data from the
// Express request object, call a service, and build the HTTP response. Database
// queries and password hashing stay in the repository and service layers.
const register = async (req, res, next) => {
    try {
        // express.json() parses the incoming JSON body and stores it in req.body.
        // Using an empty object when no body exists lets the service produce its
        // normal validation error instead of causing a destructuring error here.
        const { name, email, password } = req.body ?? {};

        // Registration includes asynchronous database and bcrypt work. await
        // pauses this controller until the service finishes, without blocking
        // Node.js from processing other requests.
        const user = await authService.registerUser(name, email, password);

        // Build the response from an explicit allow-list. This is safer than
        // removing only known sensitive fields because a future internal field
        // will stay private unless it is deliberately added here.
        const safeUser = {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            created_at: user.created_at
        };

        // HTTP 201 Created tells the client that a new user was successfully
        // created. The response contains a message and only safe user fields.
        res.status(201).json({
            message: "User registered successfully",
            user: safeUser
        });
    } catch (error) {
        // next(error) forwards validation, duplicate-email, and unexpected
        // failures to the application's existing centralized error middleware.
        next(error);
    }
};

// Handle POST /api/auth/login. The controller reads HTTP input and formats the
// response; credential verification and token creation remain in the service.
const login = async (req, res, next) => {
    try {
        // express.json() places the submitted JSON fields in req.body.
        const { email, password } = req.body ?? {};

        // Await the service because database lookup, bcrypt comparison, and the
        // surrounding login workflow complete asynchronously.
        const { user, token } = await authService.loginUser(email, password);

        // A successful login uses the default HTTP 200 OK status. The safe user
        // contains no password fields, and the token authenticates later calls.
        res.json({
            message: "Login successful",
            user,
            token
        });
    } catch (error) {
        // Forward expected and unexpected errors to the shared error middleware.
        next(error);
    }
};

// Handle GET /api/auth/me after authentication middleware has verified the JWT.
const me = async (req, res, next) => {
    try {
        // The middleware places the verified token identity on req.user. Using
        // that trusted userId prevents clients from requesting another profile.
        const user = await authService.getCurrentUser(req.user.userId);
        res.json({ user });
    } catch (error) {
        next(error);
    }
};

// Export the controller function so the authentication router can use it.
module.exports = {
    register,
    login,
    me
};
