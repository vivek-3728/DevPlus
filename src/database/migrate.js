const fs = require("node:fs/promises");
const path = require("node:path");
const { getErrorLogMessage } = require("../utils/errorDiagnostics");
const defaultPool = require("../config/db");

// PostgreSQL advisory locks are application-defined locks identified by a
// number. Holding this lock prevents two DevPulse processes from applying the
// same migration at the same time during a deployment.
const MIGRATION_LOCK_ID = 437004;
const defaultMigrationsDirectory = path.resolve(__dirname, "../../migrations");

/**
 * Return migration filenames in the order PostgreSQL should apply them.
 * Zero-padded names such as 001 and 002 make ordinary filename ordering match
 * the history order humans expect.
 */
const listMigrationFiles = async (migrationsDirectory) => {
    const entries = await fs.readdir(migrationsDirectory, { withFileTypes: true });
    const filenames = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, "en"));

    // Windows treats differently-cased filenames as the same file while Linux
    // does not. Rejecting case-only duplicates keeps migration history portable.
    const caseInsensitiveNames = filenames.map((filename) => filename.toLowerCase());
    if (new Set(caseInsensitiveNames).size !== caseInsensitiveNames.length) {
        throw new Error("Migration filenames must be unique regardless of letter case");
    }

    return filenames;
};

/**
 * Apply every migration that is not already present in schema_migrations.
 * Each SQL file and its history record share one transaction: either both are
 * committed, or both are rolled back when an error occurs.
 */
const runMigrations = async ({
    pool = defaultPool,
    migrationsDirectory = defaultMigrationsDirectory
} = {}) => {
    const client = await pool.connect();
    let lockAcquired = false;

    try {
        await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
        lockAcquired = true;

        // This small metadata table is the migration system's memory. Its
        // primary key guarantees a filename can be recorded only once.
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename VARCHAR(255) PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const migrationFiles = await listMigrationFiles(migrationsDirectory);
        const historyResult = await client.query(
            "SELECT filename FROM schema_migrations ORDER BY filename"
        );
        const appliedNames = new Set(historyResult.rows.map((row) => row.filename));
        const result = { applied: [], skipped: [] };

        for (const filename of migrationFiles) {
            if (appliedNames.has(filename)) {
                result.skipped.push(filename);
                continue;
            }

            const sql = await fs.readFile(path.join(migrationsDirectory, filename), "utf8");
            await client.query("BEGIN");
            try {
                await client.query(sql);
                await client.query(
                    "INSERT INTO schema_migrations (filename) VALUES ($1)",
                    [filename]
                );
                await client.query("COMMIT");
                result.applied.push(filename);
            } catch (error) {
                await client.query("ROLLBACK");
                throw new Error(`Migration ${filename} failed: ${error.message}`, {
                    cause: error
                });
            }
        }

        return result;
    } finally {
        try {
            if (lockAcquired) {
                await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
            }
        } finally {
            client.release();
        }
    }
};

const runFromCommandLine = async () => {
    try {
        const result = await runMigrations();
        for (const filename of result.applied) {
            console.log(`Applied migration: ${filename}`);
        }
        for (const filename of result.skipped) {
            console.log(`Skipped migration (already applied): ${filename}`);
        }
        console.log(`Migration complete: ${result.applied.length} applied, ${result.skipped.length} skipped.`);
    } catch (error) {
        console.error(getErrorLogMessage(error));
        process.exitCode = 1;
    } finally {
        await defaultPool.end();
    }
};

if (require.main === module) {
    runFromCommandLine();
}

module.exports = {
    listMigrationFiles,
    runMigrations
};
