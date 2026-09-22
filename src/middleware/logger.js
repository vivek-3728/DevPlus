// ======================================================
// LOGGER MIDDLEWARE - Logs all HTTP requests
// ======================================================

// Define the logger middleware function with three standard middleware parameters
const logger = (req, res, next) => {
    // Each request gets its own start value, retained by the finish callback (a closure).
    // Record the current timestamp in milliseconds when request arrives
    const start = Date.now();

    // Register an event listener for when the response finishes being sent
    res.on("finish", () => {
        // finish means the server handed off the response, not that the client read it.
        // Calculate the duration by subtracting start time from current time
        const duration = Date.now() - start;

        // Log the request details: HTTP method, URL path, response status code, and duration
        console.log(
            `${req.method} ${req.url} ${res.statusCode} - ${duration}ms`
        );
    });

    // Pass control to the next middleware or route handler in the chain
    next();
    // The callback runs later; next() lets the route handle the request immediately.
    // JSON parsing runs before this middleware, so malformed JSON can bypass this logger.
};

// Export the logger middleware function for use in the main server file
module.exports = logger;