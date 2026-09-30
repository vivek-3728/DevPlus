// All paths below are relative to /api/projects, where the server mounts this router.
const express = require("express");
const router = express.Router();
const projectController = require("../controllers/projectController");
const authenticate = require("../middleware/authenticate");
const authorizeRoles = require("../middleware/authorizeRoles");

// Every project endpoint requires a verified JWT and a recognized application
// role. Ownership checks for individual rows live in the service layer.
router.use(authenticate, authorizeRoles("user", "admin"));

router.get("/", projectController.getProjects); // Read the ordered project list.
router.get("/:id", projectController.getProjectById); // Read one project.
router.post("/", projectController.createProject); // Create; the database assigns an ID.
router.post("/:id/analytics-jobs", projectController.createAnalyticsSnapshotJob);
router.put("/:id", projectController.updateProject); // Replace name and environment.
router.delete("/:id", projectController.deleteProject); // Delete one project.

module.exports = router;
