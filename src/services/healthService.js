const checkPostgresReadiness = async (database, timeoutMs) => {
    // PostgreSQL is DevPulse's source of truth, so a tiny query verifies that
    // the application can obtain a connection and execute normal database work.
    await database.query({ text: "SELECT 1", query_timeout: timeoutMs });
};

module.exports = { checkPostgresReadiness };
