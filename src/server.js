// Import the express framework for creating the server
const express = require("express");
require("dotenv").config();//load environment variables from .env file
// Import custom middleware modules
const logger = require("./middleware/logger"); // Middleware to log all HTTP requests
const projectRoutes = require("./routes/projectRoutes"); // Routes for project API endpoints
const errorHandler = require("./middleware/errorHandler"); // Middleware to handle application errors

// Create an Express application instance
const app = express();

// Define the port number where the server will listen
const PORT = process.env.PORT || 5000;// Use the PORT from environment variables or default to 5000 if not set

// Middleware to parse incoming JSON request bodies
app.use(express.json());

// Middleware to log every incoming request (must come before routes)
app.use(logger);

// Mount the project routes at the /api/projects path
app.use("/api/projects", projectRoutes);

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
const pool = require("./config/db");

pool.query("SELECT NOW()")
    .then(result => {
        console.log("PostgreSQL connected:", result.rows[0]);
    })
    .catch(error => {
        console.error("PostgreSQL connection failed:", error);
    });