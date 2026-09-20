const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Pool } = require("pg");
const { runMigrations } = require("../src/database/migrate");
const sharedPool = require("../src/config/db");
const projectRepository = require("../src/repositories/projectRepository");

const migrationsDirectory = path.resolve(__dirname, "../migrations");
const safeSchemaPattern = /^devpulse_transaction_test_[a-f0-9]+$/;
const schemaName = `devpulse_transaction_test_${crypto.randomBytes(8).toString("hex")}`;

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

const adminPool = new Pool(databaseConfig());
const originalConnect = sharedPool.connect;
let schemaPool;
let ownerId;

before(async () => {
    await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    schemaPool = new Pool({
        ...databaseConfig(),
        options: `-c search_path=${schemaName}`
    });
    await runMigrations({ pool: schemaPool, migrationsDirectory });

    const owner = await schemaPool.query(
        `INSERT INTO users (name, email, password_hash)
         VALUES ('Transaction Owner', 'transaction@example.com', 'hash')
         RETURNING id`
    );
    ownerId = owner.rows[0].id;

    // This test-only trigger forces the second write to fail. The application
    // must then roll back the project row that was inserted first.
    await schemaPool.query(`
        CREATE FUNCTION reject_rollback_project_audit()
        RETURNS trigger AS $$
        BEGIN
            IF NEW.project_name = 'Rollback project' THEN
                RAISE EXCEPTION 'forced audit failure';
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER reject_rollback_project_audit_trigger
        BEFORE INSERT ON project_audit_log
        FOR EACH ROW EXECUTE FUNCTION reject_rollback_project_audit();
    `);

    // The repository calls connect() on its shared pool. Redirect only this
    // test process to the isolated schema so real application data is untouched.
    sharedPool.connect = schemaPool.connect.bind(schemaPool);
});

after(async () => {
    sharedPool.connect = originalConnect;
    if (schemaPool) await schemaPool.end();
    await adminPool.query(`DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
    await sharedPool.end();
});

test("real PostgreSQL transaction commits both project and audit rows", async () => {
    const created = await projectRepository.createProject({
        name: "Committed project",
        environment: "production",
        ownerId
    });

    const rows = await schemaPool.query(
        `SELECT
             p.id AS project_id,
             p.owner_id,
             a.action,
             a.actor_user_id,
             a.project_name,
             a.environment
         FROM projects AS p
         JOIN project_audit_log AS a ON a.project_id = p.id
         WHERE p.id = $1`,
        [created.id]
    );

    assert.deepEqual(rows.rows, [{
        project_id: created.id,
        owner_id: ownerId,
        action: "created",
        actor_user_id: ownerId,
        project_name: "Committed project",
        environment: "production"
    }]);
});

test("real PostgreSQL transaction rolls back the project when audit insertion fails", async () => {
    await assert.rejects(
        projectRepository.createProject({
            name: "Rollback project",
            environment: "development",
            ownerId
        }),
        /forced audit failure/
    );

    const projectCount = await schemaPool.query(
        "SELECT COUNT(*) AS total FROM projects WHERE name = 'Rollback project'"
    );
    const auditCount = await schemaPool.query(
        "SELECT COUNT(*) AS total FROM project_audit_log WHERE project_name = 'Rollback project'"
    );

    assert.equal(projectCount.rows[0].total, "0");
    assert.equal(auditCount.rows[0].total, "0");
});
