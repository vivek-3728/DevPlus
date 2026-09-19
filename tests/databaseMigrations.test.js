const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Pool } = require("pg");
const { runMigrations } = require("../src/database/migrate");
const sharedPool = require("../src/config/db");
const projectRepository = require("../src/repositories/projectRepository");

const migrationsDirectory = path.resolve(__dirname, "../migrations");
const safeSchemaPattern = /^devpulse_migration_test_[a-f0-9]+$/;

const databaseConfig = () => ({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT)
});

const quoteIdentifier = (identifier) => {
    if (!safeSchemaPattern.test(identifier)) {
        throw new Error(`Refusing to use unsafe test schema name: ${identifier}`);
    }
    return `"${identifier}"`;
};

const newSchemaName = () =>
    `devpulse_migration_test_${crypto.randomBytes(8).toString("hex")}`;

const createIsolatedSchema = async (adminPool) => {
    const schemaName = newSchemaName();
    await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    const schemaPool = new Pool({
        ...databaseConfig(),
        options: `-c search_path=${schemaName}`
    });
    return { schemaName, schemaPool };
};

const dropIsolatedSchema = async (adminPool, schemaName, schemaPool) => {
    await schemaPool.end();
    await adminPool.query(`DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE`);
};

const createLegacySchema = async (schemaPool, environment = "development") => {
    await schemaPool.query(`
        CREATE TABLE users (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(255) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            role VARCHAR(20) NOT NULL DEFAULT 'user',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE projects (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            environment VARCHAR(50) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    // Let the SERIAL default assign ID 1 so later inserts continue at ID 2,
    // matching how the real application created its legacy row.
    await schemaPool.query(
        "INSERT INTO projects (name, environment) VALUES ('Legacy project', $1)",
        [environment]
    );
};

const expectPostgresCode = async (operation, expectedCode) => {
    await assert.rejects(operation, (error) => {
        assert.equal(error.code, expectedCode);
        return true;
    });
};

const adminPool = new Pool(databaseConfig());
let mainSchemaName;
let mainPool;

before(async () => {
    const isolated = await createIsolatedSchema(adminPool);
    mainSchemaName = isolated.schemaName;
    mainPool = isolated.schemaPool;
    await createLegacySchema(mainPool);
});

after(async () => {
    if (mainPool) {
        await dropIsolatedSchema(adminPool, mainSchemaName, mainPool);
    }
    await adminPool.end();
});

test("migrations apply once and record each filename once", async () => {
    const firstRun = await runMigrations({ pool: mainPool, migrationsDirectory });
    const secondRun = await runMigrations({ pool: mainPool, migrationsDirectory });

    assert.deepEqual(firstRun, {
        applied: [
            "001_current_schema.sql",
            "002_project_ownership.sql",
            "003_project_environment_constraint.sql",
            "004_project_owner_index.sql",
            "005_validate_reused_constraints.sql"
        ],
        skipped: []
    });
    assert.deepEqual(secondRun, {
        applied: [],
        skipped: firstRun.applied
    });
    const history = await mainPool.query(
        "SELECT filename FROM schema_migrations ORDER BY filename"
    );
    assert.deepEqual(history.rows.map((row) => row.filename), firstRun.applied);
});

test("migration preserves the legacy project with nullable ownership", async () => {
    const result = await mainPool.query(
        "SELECT id, name, environment, owner_id FROM projects WHERE id = 1"
    );

    assert.deepEqual(result.rows[0], {
        id: 1,
        name: "Legacy project",
        environment: "development",
        owner_id: null
    });
});

test("existing primary keys and unique user email remain enforced", async () => {
    await mainPool.query(
        "INSERT INTO users (id, name, email, password_hash) VALUES (20, 'First', 'unique@example.com', 'hash')"
    );

    await expectPostgresCode(
        mainPool.query(
            "INSERT INTO users (id, name, email, password_hash) VALUES (20, 'Duplicate ID', 'other@example.com', 'hash')"
        ),
        "23505"
    );
    await expectPostgresCode(
        mainPool.query(
            "INSERT INTO users (name, email, password_hash) VALUES ('Duplicate email', 'unique@example.com', 'hash')"
        ),
        "23505"
    );
});

test("project environment constraint rejects unsupported values", async () => {
    await expectPostgresCode(
        mainPool.query(
            "INSERT INTO projects (name, environment) VALUES ('Invalid', 'staging')"
        ),
        "23514"
    );
});

test("ownership foreign key rejects missing users and sets ownership null on delete", async () => {
    await expectPostgresCode(
        mainPool.query(
            "INSERT INTO projects (name, environment, owner_id) VALUES ('Missing owner', 'production', 999999)"
        ),
        "23503"
    );

    const userResult = await mainPool.query(
        "INSERT INTO users (name, email, password_hash) VALUES ('Owner', 'owner@example.com', 'hash') RETURNING id"
    );
    const projectResult = await mainPool.query(
        "INSERT INTO projects (name, environment, owner_id) VALUES ('Owned', 'production', $1) RETURNING id",
        [userResult.rows[0].id]
    );
    await mainPool.query("DELETE FROM users WHERE id = $1", [userResult.rows[0].id]);
    const preserved = await mainPool.query(
        "SELECT owner_id FROM projects WHERE id = $1",
        [projectResult.rows[0].id]
    );

    assert.equal(preserved.rows[0].owner_id, null);
});

test("schema has one ownership foreign key, one environment check, and one owner index", async () => {
    const foreignKeys = await mainPool.query(`
        SELECT confdeltype
        FROM pg_constraint
        WHERE conrelid = 'projects'::regclass
          AND contype = 'f'
    `);
    const checks = await mainPool.query(`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'projects'::regclass
          AND contype = 'c'
    `);
    const ownerIndexes = await mainPool.query(`
        SELECT indexrelid::regclass::text AS index_name
        FROM pg_index
        WHERE indrelid = 'projects'::regclass
          AND indisvalid
          AND indpred IS NULL
          AND indnkeyatts = 1
          AND indkey::text = (
              SELECT attnum::text
              FROM pg_attribute
              WHERE attrelid = 'projects'::regclass
                AND attname = 'owner_id'
          )
    `);

    assert.deepEqual(foreignKeys.rows, [{ confdeltype: "n" }]);
    assert.equal(checks.rows.length, 1);
    assert.match(checks.rows[0].definition, /production/);
    assert.match(checks.rows[0].definition, /development/);
    assert.equal(ownerIndexes.rows.length, 1);
});

test("invalid legacy environment aborts its migration without changing the row", async () => {
    const isolated = await createIsolatedSchema(adminPool);
    try {
        await createLegacySchema(isolated.schemaPool, "staging");

        await assert.rejects(
            runMigrations({ pool: isolated.schemaPool, migrationsDirectory }),
            (error) => {
                assert.match(error.message, /003_project_environment_constraint\.sql/);
                assert.equal(error.cause.code, "23514");
                return true;
            }
        );

        const project = await isolated.schemaPool.query(
            "SELECT environment FROM projects WHERE id = 1"
        );
        const history = await isolated.schemaPool.query(
            "SELECT filename FROM schema_migrations ORDER BY filename"
        );
        assert.equal(project.rows[0].environment, "staging");
        assert.deepEqual(history.rows.map((row) => row.filename), [
            "001_current_schema.sql",
            "002_project_ownership.sql"
        ]);
    } finally {
        await dropIsolatedSchema(adminPool, isolated.schemaName, isolated.schemaPool);
    }
});

test("a weaker existing environment check does not count as the required constraint", async () => {
    const isolated = await createIsolatedSchema(adminPool);
    try {
        await createLegacySchema(isolated.schemaPool, "qa");
        await isolated.schemaPool.query(`
            ALTER TABLE projects
            ADD CONSTRAINT custom_environment_check
            CHECK (environment IN ('production', 'development', 'qa'))
        `);

        await assert.rejects(
            runMigrations({ pool: isolated.schemaPool, migrationsDirectory }),
            (error) => {
                assert.match(error.message, /005_validate_reused_constraints\.sql/);
                assert.equal(error.cause.code, "23514");
                return true;
            }
        );

        const project = await isolated.schemaPool.query(
            "SELECT environment FROM projects WHERE id = 1"
        );
        assert.equal(project.rows[0].environment, "qa");
    } finally {
        await dropIsolatedSchema(adminPool, isolated.schemaName, isolated.schemaPool);
    }
});

test("an equivalent NOT VALID environment check is validated before migration succeeds", async () => {
    const isolated = await createIsolatedSchema(adminPool);
    try {
        await createLegacySchema(isolated.schemaPool, "qa");
        await isolated.schemaPool.query(`
            ALTER TABLE projects
            ADD CONSTRAINT custom_environment_check
            CHECK (environment IN ('production', 'development')) NOT VALID
        `);

        await assert.rejects(
            runMigrations({ pool: isolated.schemaPool, migrationsDirectory }),
            (error) => {
                assert.match(error.message, /005_validate_reused_constraints\.sql/);
                assert.equal(error.cause.code, "23514");
                assert.equal(error.cause.constraint, "custom_environment_check");
                return true;
            }
        );
    } finally {
        await dropIsolatedSchema(adminPool, isolated.schemaName, isolated.schemaPool);
    }
});

test("an equivalent NOT VALID ownership foreign key is validated before migration succeeds", async () => {
    const isolated = await createIsolatedSchema(adminPool);
    try {
        await createLegacySchema(isolated.schemaPool);
        await isolated.schemaPool.query("ALTER TABLE projects ADD COLUMN owner_id INTEGER");
        await isolated.schemaPool.query("UPDATE projects SET owner_id = 999999 WHERE id = 1");
        await isolated.schemaPool.query(`
            ALTER TABLE projects
            ADD CONSTRAINT custom_owner_fkey
            FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL NOT VALID
        `);

        await assert.rejects(
            runMigrations({ pool: isolated.schemaPool, migrationsDirectory }),
            (error) => {
                assert.match(error.message, /005_validate_reused_constraints\.sql/);
                assert.equal(error.cause.code, "23503");
                assert.equal(error.cause.constraint, "custom_owner_fkey");
                return true;
            }
        );
    } finally {
        await dropIsolatedSchema(adminPool, isolated.schemaName, isolated.schemaPool);
    }
});

test("an equivalent owner index with a different name is reused", async () => {
    const isolated = await createIsolatedSchema(adminPool);
    try {
        await createLegacySchema(isolated.schemaPool);
        await isolated.schemaPool.query("ALTER TABLE projects ADD COLUMN owner_id INTEGER");
        await isolated.schemaPool.query(
            "CREATE INDEX custom_owner_lookup ON projects USING btree (owner_id)"
        );

        await runMigrations({ pool: isolated.schemaPool, migrationsDirectory });

        const ownerIndexes = await isolated.schemaPool.query(`
            SELECT indexrelid::regclass::text AS index_name
            FROM pg_index
            WHERE indrelid = 'projects'::regclass
              AND indisvalid
              AND indpred IS NULL
              AND indnkeyatts = 1
              AND indkey::text = (
                  SELECT attnum::text
                  FROM pg_attribute
                  WHERE attrelid = 'projects'::regclass
                    AND attname = 'owner_id'
              )
        `);
        assert.deepEqual(ownerIndexes.rows, [{ index_name: "custom_owner_lookup" }]);
    } finally {
        await dropIsolatedSchema(adminPool, isolated.schemaName, isolated.schemaPool);
    }
});

test("repository LEFT JOIN returns safe owner data and keeps legacy projects", async () => {
    const owner = await mainPool.query(
        "INSERT INTO users (name, email, password_hash) VALUES ('Join Owner', 'join-owner@example.com', 'private-hash') RETURNING id"
    );
    await mainPool.query(
        "INSERT INTO projects (name, environment, owner_id) VALUES ('Joined project', 'production', $1)",
        [owner.rows[0].id]
    );

    const originalQuery = sharedPool.query;
    sharedPool.query = (sql, values) => mainPool.query(sql, values);
    try {
        const projects = await projectRepository.getProjectsWithOwners();
        const legacy = projects.find((project) => project.project_id === 1);
        const joined = projects.find((project) => project.project_name === "Joined project");

        assert.deepEqual(legacy, {
            project_id: 1,
            project_name: "Legacy project",
            environment: "development",
            owner_id: null,
            owner_name: null,
            owner_email: null
        });
        assert.deepEqual(joined, {
            project_id: joined.project_id,
            project_name: "Joined project",
            environment: "production",
            owner_id: owner.rows[0].id,
            owner_name: "Join Owner",
            owner_email: "join-owner@example.com"
        });
        assert.equal(projects.every((project) => !Object.hasOwn(project, "password_hash")), true);
    } finally {
        sharedPool.query = originalQuery;
    }
});
