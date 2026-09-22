// Import Express so this file can create a router for authentication endpoints.
const express = require("express");

// Import the controller that handles authentication HTTP requests and responses.
const authController = require("../controllers/authController");

// This middleware verifies JWTs before protected controllers are allowed to run.
const authenticate = require("../middleware/authenticate");

// A router groups related endpoints. The main server mounts this router at
// /api/auth, so every path declared here starts after that URL prefix.
const router = express.Router();

// Routes decide which controller handles an incoming HTTP method and path.
// Combined with the /api/auth prefix, this becomes POST /api/auth/register.
router.post("/register", authController.register);

// Login is public because a user does not have a token until login succeeds.
router.post("/login", authController.login);

// /me is protected. Requests reach the controller only after the Bearer token
// is verified and the authenticated identity has been attached to req.user.
router.get("/me", authenticate, authController.me);

// Export the router so the existing Express application can mount it.
module.exports = router;
