const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const createMigrationDirectory = async (files) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "devpulse-migrations-"));
    await Promise.all(
        Object.entries(files).map(([filename, sql]) =>
            fs.writeFile(path.join(directory, filename), sql, "utf8")
        )
    );
    return directory;
};

const createFakePool = ({ applied = [], failOnSql } = {}) => {
    const calls = [];
    const recorded = [...applied];
    let released = false;

    const client = {
        query: async (sql, values = []) => {
            const normalizedSql = sql.trim();
            calls.push({ sql: normalizedSql, values });

            if (failOnSql && normalizedSql.includes(failOnSql)) {
                throw new Error("deliberate migration failure");
            }
            if (/^SELECT filename FROM schema_migrations/i.test(normalizedSql)) {
                return { rows: recorded.map((filename) => ({ filename })) };
            }
            if (/^INSERT INTO schema_migrations/i.test(normalizedSql)) {
                recorded.push(values[0]);
            }
            return { rows: [] };
        },
        release: () => {
            released = true;
        }
    };

    return {
        pool: { connect: async () => client },
        calls,
        recorded,
        wasReleased: () => released
    };
};

test("listMigrationFiles returns only SQL files in filename order", async (context) => {
    const directory = await createMigrationDirectory({
        "010_last.sql": "SELECT 10;",
        "002_middle.SQL": "SELECT 2;",
        "001_first.sql": "SELECT 1;",
        "notes.txt": "not a migration"
    });
    context.after(() => fs.rm(directory, { recursive: true, force: true }));

    const { listMigrationFiles } = require("../src/database/migrate");

    assert.deepEqual(await listMigrationFiles(directory), [
        "001_first.sql",
        "002_middle.SQL",
        "010_last.sql"
    ]);
});

test("runMigrations applies pending files and skips recorded files", async (context) => {
    const directory = await createMigrationDirectory({
        "001_first.sql": "SELECT 'first';",
        "002_second.sql": "SELECT 'second';"
    });
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const fake = createFakePool({ applied: ["001_first.sql"] });
    const { runMigrations } = require("../src/database/migrate");

    const result = await runMigrations({
        pool: fake.pool,
        migrationsDirectory: directory
    });

    assert.deepEqual(result, {
        applied: ["002_second.sql"],
        skipped: ["001_first.sql"]
    });
    assert.deepEqual(fake.recorded, ["001_first.sql", "002_second.sql"]);
    assert.equal(fake.calls.filter((call) => call.sql === "BEGIN").length, 1);
    assert.equal(fake.calls.filter((call) => call.sql === "COMMIT").length, 1);
    assert.equal(fake.calls.some((call) => call.sql === "SELECT 'first';"), false);
    assert.equal(fake.calls.some((call) => call.sql === "SELECT 'second';"), true);
    assert.deepEqual(
        fake.calls.filter((call) => /pg_advisory_(lock|unlock)/i.test(call.sql)).map((call) => call.values),
        [[437004], [437004]]
    );
    assert.equal(fake.wasReleased(), true);
});

test("runMigrations rolls back and does not record a failed migration", async (context) => {
    const directory = await createMigrationDirectory({
        "001_broken.sql": "BROKEN SQL;"
    });
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const fake = createFakePool({ failOnSql: "BROKEN" });
    const { runMigrations } = require("../src/database/migrate");

    await assert.rejects(
        runMigrations({ pool: fake.pool, migrationsDirectory: directory }),
        /Migration 001_broken\.sql failed: deliberate migration failure/
    );

    assert.equal(fake.calls.some((call) => call.sql === "ROLLBACK"), true);
    assert.equal(fake.calls.some((call) => /^INSERT INTO schema_migrations/i.test(call.sql)), false);
    assert.equal(fake.calls.some((call) => /pg_advisory_unlock/i.test(call.sql)), true);
    assert.equal(fake.wasReleased(), true);
});
