const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const sharedPool = require("../src/config/db");
const projectService = require("../src/services/projectService");

const databaseConfig = () => ({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT)
});

const schemaName = `devpulse_query_test_${crypto.randomBytes(8).toString("hex")}`;
const quotedSchemaName = `"${schemaName}"`;
const adminPool = new Pool(databaseConfig());
let schemaPool;
let originalQuery;

before(async () => {
    await adminPool.query(`CREATE SCHEMA ${quotedSchemaName}`);
    schemaPool = new Pool({
        ...databaseConfig(),
        options: `-c search_path=${schemaName}`
    });

    await schemaPool.query(`
        CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(255) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL
        );
        CREATE TABLE projects (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            environment VARCHAR(50) NOT NULL,
            owner_id INTEGER REFERENCES users(id),
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await schemaPool.query(`
        INSERT INTO users (id, name, email, password_hash) VALUES
            (31, 'Owner One', 'one@example.com', 'not-returned'),
            (44, 'Owner Two', 'two@example.com', 'not-returned');
        INSERT INTO projects (name, environment, owner_id) VALUES
            ('Dev Alpha', 'production', 31),
            ('Dev Beta', 'production', 31),
            ('Other Tool', 'development', 31),
            ('Dev Zeta', 'production', 31),
            ('Dev Secret', 'production', 44),
            ('Dev Legacy', 'production', NULL);
    `);
    await schemaPool.query(
        "INSERT INTO projects (name, environment, owner_id) VALUES ($1, 'production', 31)",
        ["Literal 50%_\\done"]
    );

    // Point only this test process at the isolated schema. No real application
    // data is changed, and the original shared method is restored afterward.
    originalQuery = sharedPool.query;
    sharedPool.query = schemaPool.query.bind(schemaPool);
});

after(async () => {
    sharedPool.query = originalQuery;
    if (schemaPool) await schemaPool.end();
    await adminPool.query(`DROP SCHEMA ${quotedSchemaName} CASCADE`);
    await adminPool.end();
    await sharedPool.end();
});

test("PostgreSQL combines case-insensitive search, filtering, sorting, and pagination", async () => {
    const result = await projectService.getProjects({
        search: "dEv",
        environment: "production",
        page: "2",
        limit: "1",
        sort: "name",
        order: "asc"
    }, { userId: 31, role: "user" });

    assert.equal(result.total, 3);
    assert.equal(result.totalPages, 3);
    assert.deepEqual(result.projects.map((project) => project.name), ["Dev Beta"]);
    assert.equal(result.projects.every((project) => project.owner_id === 31), true);

    const beyondLastPage = await projectService.getProjects({
        search: "dev", page: "4", limit: "1", sort: "name", order: "asc"
    }, { userId: 31, role: "user" });
    assert.equal(beyondLastPage.total, 3);
    assert.deepEqual(beyondLastPage.projects, []);
});

test("PostgreSQL treats search wildcard characters as literal text", async () => {
    const result = await projectService.getProjects({
        search: "50%_\\done"
    }, { userId: 31, role: "user" });

    assert.equal(result.total, 1);
    assert.deepEqual(result.projects.map((project) => project.name), ["Literal 50%_\\done"]);
});

test("admins can query other and legacy projects while users cannot discover them", async () => {
    const query = {
        search: "dev",
        environment: "production",
        sort: "name",
        order: "desc",
        page: "1",
        limit: "10"
    };

    const userResult = await projectService.getProjects(query, { userId: 31, role: "user" });
    const adminResult = await projectService.getProjects(query, { userId: 1, role: "admin" });

    assert.equal(userResult.total, 3);
    assert.equal(adminResult.total, 5);
    assert.equal(userResult.projects.some((project) => project.owner_id !== 31), false);
    assert.equal(adminResult.projects.some((project) => project.owner_id === 44), true);
    assert.equal(adminResult.projects.some((project) => project.owner_id === null), true);
});
