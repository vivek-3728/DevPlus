// ======================================================
// LOGGER MIDDLEWARE - Logs all HTTP requests
// ======================================================

// Define the logger middleware function with three standard middleware parameters
const logger = (req, res, next) => {
    // Record the current timestamp in milliseconds when request arrives
    const start = Date.now();

    // Register an event listener for when the response finishes being sent
    res.on("finish", () => {
        // Calculate the duration by subtracting start time from current time
        const duration = Date.now() - start;

        // Log the request details: HTTP method, URL path, response status code, and duration
        console.log(
            `${req.method} ${req.url} ${res.statusCode} - ${duration}ms`
        );
    });

    // Pass control to the next middleware or route handler in the chain
    next();
};

// Export the logger middleware function for use in the main server file
module.exports = logger;