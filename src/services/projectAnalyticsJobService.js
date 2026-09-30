const AppError = require("../errors/Apperror");
const projectService = require("./projectService");
const projectAnalyticsQueue = require("../queues/projectAnalyticsQueue");
const { getErrorLogMessage } = require("../utils/errorDiagnostics");
const { logger } = require("../utils/structuredLogger");
const { PROJECT_ANALYTICS_JOB_NAME } = require("../config/queue");

const enqueueProjectAnalyticsSnapshot = async (id, actor, {
    addJob = projectAnalyticsQueue.addProjectAnalyticsJob,
    jobLogger = logger
} = {}) => {
    // Reuse the existing ownership/admin authorization before creating a job.
    // A queued ID must never reveal or schedule work for an inaccessible row.
    const project = await projectService.getProjectById(id, actor);

    try {
        const job = await addJob(project.id);
        jobLogger.info("project.analytics_job_queued", {
            jobId: String(job.id),
            jobName: PROJECT_ANALYTICS_JOB_NAME,
            projectId: project.id
        });
        return { jobId: String(job.id) };
    } catch (error) {
        // The API returns 202 only after Redis confirms the durable queue write.
        // If Redis is missing/offline, report that the operation was not accepted.
        jobLogger.warn("project.analytics_job_enqueue_failed", {
            projectId: project.id,
            message: getErrorLogMessage(error)
        });
        throw new AppError("Background job queue is unavailable", 503);
    }
};

module.exports = { enqueueProjectAnalyticsSnapshot };
