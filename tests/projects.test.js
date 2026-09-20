const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');
const { getJwtSecret } = require('../src/config/auth');
const routes = require('../src/routes/projectRoutes');
const errorHandler = require('../src/middleware/errorHandler');

const adminToken = jwt.sign({ userId: 1, role: 'admin' }, getJwtSecret());
const userToken = jwt.sign({ userId: 31, role: 'user' }, getJwtSecret());
const guestToken = jwt.sign({ userId: 44, role: 'guest' }, getJwtSecret());
const userTokenWithoutId = jwt.sign({ role: 'user' }, getJwtSecret());

// Exercise the real HTTP/router/controller/service/repository chain. Only the
// external PostgreSQL query is replaced, so this suite needs no local database.
let server, base, calls, answer, releases;
const originalQuery = pool.query;
const originalConnect = pool.connect;
before(async () => {
    pool.query = async (sql, values) => {
        calls.push({ sql, values });
        return answer(sql, values);
    };
    pool.connect = async () => ({
        query: async (sql, values) => {
            calls.push({ sql, values });
            return answer(sql, values);
        },
        release: () => { releases += 1; }
    });
    const app = express();
    app.use(express.json());
    app.use('/api/projects', routes);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/projects`;
});
beforeEach(() => {
    calls = [];
    releases = 0;
    answer = async (sql) => /COUNT\(\*\)/i.test(sql)
        ? ({ rows: [{ total: '0' }], rowCount: 1 })
        : ({ rows: [], rowCount: 0 });
});
after(async () => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    await new Promise(resolve => server.close(resolve));
    await pool.end();
});
const request = (path = '', method = 'GET', body, token = adminToken) => fetch(base + path, {
    method,
    headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

test('list returns paginated database rows in ID order', async () => {
    answer = async (sql) => /COUNT\(\*\)/i.test(sql)
        ? ({ rows: [{ total: '1' }], rowCount: 1 })
        : ({ rows: [{ id: 3, name: 'Existing', environment: 'production' }], rowCount: 1 });
    const res = await request();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
        page: 1,
        limit: 10,
        total: 1,
        totalPages: 1,
        projects: [{ id: 3, name: 'Existing', environment: 'production' }]
    });
    assert.match(calls[1].sql, /ORDER BY p\.id ASC/i);
});
test('empty list returns pagination metadata and an empty projects array', async () => {
    const res = await request();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
        page: 1, limit: 10, total: 0, totalPages: 0, projects: []
    });
});

test('combined query parameters reach safe owner-scoped SQL', async () => {
    answer = async (sql) => /COUNT\(\*\)/i.test(sql)
        ? ({ rows: [{ total: '11' }] })
        : ({ rows: [{ id: 9, name: 'Dev API', owner_id: 31 }] });

    const res = await request(
        '?search=dev&environment=production&page=2&limit=10&sort=name&order=asc',
        'GET',
        undefined,
        userToken
    );

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
        page: 2,
        limit: 10,
        total: 11,
        totalPages: 2,
        projects: [{ id: 9, name: 'Dev API', owner_id: 31 }]
    });
    assert.match(calls[0].sql, /p\.owner_id = \$1[\s\S]*p\.environment = \$2[\s\S]*p\.name ILIKE \$3/i);
    assert.deepEqual(calls[1].values, [31, 'production', '%dev%', 10, 10]);
});

test('invalid pagination is rejected before database access', async () => {
    const res = await request('?page=0&limit=101');
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
});

test('repeated supported query parameters are rejected as ambiguous', async () => {
    const res = await request('?page=1&page=2');
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
});
test('read awaits a missing row and returns 404', async () => {
    const res = await request('/99');
    assert.equal(res.status, 404);
    assert.deepEqual(calls[0].values, [99]);
});
test('read returns the resolved database row', async () => {
    answer = async () => ({ rows: [{ id: 3, name: 'Existing', environment: 'production' }], rowCount: 1 });
    const res = await request('/3');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, 3);
});
for (const method of ['GET', 'PUT', 'DELETE']) {
    for (const id of ['0', '-1', '1.5', 'abc', '9007199254740992', '1e2', '0x10']) {
        test(`${method} rejects invalid ID ${id} before querying`, async () => {
            const res = await request('/' + id, method, method === 'PUT' ? { name: 'Valid', environment: 'production' } : undefined);
            assert.equal(res.status, 400);
            assert.equal(calls.length, 0);
        });
    }
}
for (const method of ['POST', 'PUT']) {
    for (const body of [undefined, null, [], {}, {name: '   ', environment: 'production'}, {name: 42, environment: 'production'}, {name: 'Valid'}, {name: 'Valid', environment: 'staging'}]) {
        test(`${method} rejects invalid body ${JSON.stringify(body)}`, async () => {
            const res = await request(method === 'PUT' ? '/3' : '', method, body);
            assert.equal(res.status, 400);
            assert.equal(calls.length, 0);
        });
    }
}
test('create commits its project and audit record and returns the database-generated ID', async () => {
    answer = async () => ({ rows: [{ id: 41, name: 'New', environment: 'development', owner_id: 1 }], rowCount: 1 });
    const res = await request('', 'POST', {name: 'New', environment: 'development'});
    assert.equal(res.status, 201);
    assert.equal((await res.json()).id, 41);
    assert.deepEqual(
        calls.map((call) => call.sql.replace(/\s+/g, ' ').trim().split(' ')[0]),
        ['BEGIN', 'INSERT', 'INSERT', 'COMMIT']
    );
    assert.match(calls[1].sql, /INSERT INTO projects \(name, environment, owner_id\)/i);
    assert.deepEqual(calls[1].values, ['New', 'development', 1]);
    assert.match(calls[2].sql, /INSERT INTO project_audit_log/i);
    assert.deepEqual(calls[2].values, [41, 1, 'New', 'development']);
    assert.equal(releases, 1);
});

test('create ignores body ownership and uses the authenticated user ID', async () => {
    answer = async () => ({ rows: [{ id: 42, name: 'Mine', environment: 'development', owner_id: 31 }] });
    const res = await request('', 'POST', {
        name: 'Mine', environment: 'development', owner_id: 999, userId: 999
    }, userToken);

    assert.equal(res.status, 201);
    assert.deepEqual(calls[1].values, ['Mine', 'development', 31]);
    assert.deepEqual(calls[2].values, [42, 31, 'Mine', 'development']);
});
test('update binds input as data and returns the updated row', async () => {
    const name = "O'Brien'; DROP TABLE projects; --";
    answer = async () => ({rows: [{id: 3, name, environment: 'production'}], rowCount: 1});
    const res = await request('/3', 'PUT', {name, environment: 'production'});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).name, name);
    assert.equal(calls.length, 2);
    assert.match(calls[1].sql, /UPDATE projects[\s\S]*name = \$1[\s\S]*environment = \$2[\s\S]*WHERE id = \$3[\s\S]*RETURNING \*/i);
    assert.deepEqual(calls[1].values, [name, 'production', 3]);
    assert.ok(!calls[1].sql.includes(name));
});
test('delete uses the ID and returns 204 with no response body', async () => {
    answer = async () => ({rows: [{id: 3}], rowCount: 1});
    const res = await request('/3', 'DELETE');
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
    assert.match(calls[1].sql, /DELETE FROM projects WHERE id = \$1 RETURNING id/i);
    assert.deepEqual(calls[1].values, [3]);
});
for (const method of ['PUT', 'DELETE']) {
    test(`${method} returns 404 when no row was changed`, async () => {
        const res = await request('/99', method, method === 'PUT' ? {name: 'Valid', environment: 'production'} : undefined);
        assert.equal(res.status, 404);
    });
}
for (const [path, method, body] of [ ['', 'GET'], ['/3','GET'], ['', 'POST', {name:'Valid',environment:'production'}], ['/3','PUT',{name:'Valid',environment:'production'}], ['/3','DELETE'] ]) {
    test(`${method} ${path || '/'} hides database failure details`, async () => {
        answer = async () => { throw new Error('private database details'); };
        const res = await request(path, method, body);
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), {error: 'Internal Server Error'});
    });
}
test('malformed JSON returns 400 before database access', async () => {
    const res = await fetch(base, {method:'POST',headers:{'Content-Type':'application/json'},body:'{"name":'});
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {error:'Invalid JSON payload'});
    assert.equal(calls.length, 0);
});

test('project routes require a valid authentication token', async () => {
    const res = await fetch(base);
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
});

test('a signed user token without a user ID cannot bypass owner filtering', async () => {
    const res = await request('', 'GET', undefined, userTokenWithoutId);
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
});

test('project routes reject authenticated callers with an unsupported role', async () => {
    const res = await request('', 'GET', undefined, guestToken);
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
});
