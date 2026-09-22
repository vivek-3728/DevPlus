// Alternate server file: it duplicates much of src/server.js and is not a service.
// Run directly with node src/services/server.js; src/server.js does not import it.
// Both default to port 5000, so running both together on that port would conflict.
// Unlike src/server.js, this file does not run the SELECT NOW() database check.
const express = require("express");
// Load .env before reading PORT; the database pool still uses hardcoded settings.
require("dotenv").config();

const logger = require("../middleware/logger");
const projectRoutes = require("../routes/projectRoutes");
const errorHandler = require("../middleware/errorHandler");

const app = express();
// This is a separate Express application instance from the one in src/server.js.

const PORT = process.env.PORT || 5000;


// ======================================================
// GLOBAL MIDDLEWARE
// ======================================================

// Allows Express to understand JSON sent by the client.
//
// Example:
// {
//     "name": "DevPulse",
//     "environment": "production"
// }
//
// This JSON becomes available through req.body.
app.use(express.json());


// Our custom logger runs for every request.
//
// It records:
// - HTTP method
// - URL
// - status code
// - response time
app.use(logger);


// ======================================================
// ROUTES
// ======================================================

// All routes inside projectRoutes start with:
//
// /api/projects
//
// So:
//
// router.get("/")    -> GET /api/projects
// router.post("/")   -> POST /api/projects

app.use("/api/projects", projectRoutes);


// ======================================================
// HEALTH CHECK
// ======================================================

// Used to check whether our backend is running.

app.get("/api/health", (req, res) => {
    // This reports HTTP server availability; it does not query PostgreSQL.

    res.json({
        status: "ok",
        message: "DevPulse backend is running"
    });
});


// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, () => {

    console.log(`DevPulse running on port ${PORT}`);
});


// Handles errors from routes and JSON parsing after all other middleware.
app.use(errorHandler);
// Even though this is written after listen(), it registers synchronously during
// startup. Its position after the routes is what gives it the error-handling role.