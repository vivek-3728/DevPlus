const express = require("express");
require("dotenv").config();

const logger = require("../middleware/logger");
const projectRoutes = require("../routes/projectRoutes");
const errorHandler = require("../middleware/errorHandler");

const app = express();

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