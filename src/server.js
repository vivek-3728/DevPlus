// Application entry point: run with node src/server.js from the project root.
// Request flow: JSON parser -> logger -> router -> controller -> service -> repository.
// Responses travel back to the controller; errors go to the final error middleware.
// Import the express framework for creating the server
const express = require("express");
require("dotenv").config();//load environment variables from .env file
// Import custom middleware modules
const logger = require("./middleware/logger"); // Middleware to log all HTTP requests
const projectRoutes = require("./routes/projectRoutes"); // Routes for project API endpoints
const authRoutes = require("./routes/authRoutes"); // Routes for registration and future authentication endpoints
const errorHandler = require("./middleware/errorHandler"); // Middleware to handle application errors
const { validateJwtConfig } = require("./config/auth"); // Validate required JWT environment configuration
const { connectRedis } = require("./config/redis"); // Optional cache connection

// Stop startup with a clear message when JWT_SECRET is missing or still uses the
// public example value. Running without a private secret would break login and
// make token verification insecure.
validateJwtConfig();

// Create an Express application instance
const app = express();

// Define the port number where the server will listen
const PORT = process.env.PORT || 5000;// Use the PORT from environment variables or default to 5000 if not set

// Parse incoming JSON request bodies before any route runs. Express makes the
// parsed values available to controllers through req.body.
app.use(express.json());

// Middleware to log every incoming request (must come before routes)
app.use(logger);

// Mount the project routes at the /api/projects path
app.use("/api/projects", projectRoutes);

// Mount authentication routes under /api/auth. The router's /register path
// therefore becomes the complete endpoint POST /api/auth/register.
app.use("/api/auth", authRoutes);

// Define a health check endpoint to verify the server is running
app.get("/api/health", (req, res) => { 
    // Send a JSON response indicating the server is healthy and running
    res.json({
        status: "ok",
        message: "DevPulse backend is running"
    });
});

// Middleware to handle all application errors (must come after all other routes/middleware)
app.use(errorHandler);

// Start the Express server and listen for incoming connections on the specified PORT
app.listen(PORT, () => {
    // Log to console when the server starts successfully
    console.log(`DevPulse running on port ${PORT}`);
});

// Start Redis in the background instead of making HTTP startup depend on it.
// If Redis is absent, cache operations fail open and PostgreSQL serves reads.
connectRedis();

// CommonJS caches this module, so repositories and this check share one pool.
const pool = require("./config/db");

// This asynchronous database check runs after starting the HTTP listener.
// A failure is logged; it does not stop the server or change /api/health.
pool.query("SELECT NOW()")
    .then(result => {
        console.log("PostgreSQL connected:", result.rows[0]);
    })
    .catch(error => {
        console.error("PostgreSQL connection failed:", error);
    });
