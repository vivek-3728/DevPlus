// Import the Express framework
const express = require("express");

// Create a new Express Router instance for handling project routes
const router = express.Router();

// Import the project controller that handles the route logic
const projectController = require("../controllers/projectController");

// ======================================================
// PROJECT ROUTES - Defines all project-related endpoints
// ======================================================

// Define GET route for retrieving all projects at /api/projects
router.get("/", projectController.getProjects);

// Define GET route for retrieving one project at /api/projects/:id
router.get("/:id", projectController.getProjectById);

// Define POST route for creating a new project at /api/projects
router.post("/", projectController.createProject);

// Export the router so it can be mounted in the main server file
module.exports = router;