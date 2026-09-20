# DevPulse Phase 4 Block 3: Transactions and Query Review Design

**Date:** 2026-09-20

## Goal

Add one meaningful atomic database workflow to the existing DevPulse backend,
review the Phase 4 project-query indexes without premature optimization, and
complete focused edge-case and regression testing.

Blocks 1 and 2 remain unchanged: migrations, constraints, the safe owner JOIN,
authentication, role authorization, ownership, pagination, environment
filtering, case-insensitive search, and safe sorting continue to use their
current interfaces and behavior.

## Transaction Workflow

Project creation will become an atomic two-write workflow:

1. insert the new project with `owner_id` derived from the authenticated JWT;
2. insert an internal audit row describing that creation.

These writes belong together. A project must not be created without its
required creation record, and an audit row must not describe a project insert
that was rolled back.

The transaction uses one checked-out `pg` client for every statement:

```text
pool.connect()
BEGIN
INSERT INTO projects ... RETURNING ...
INSERT INTO project_audit_log ...
COMMIT
client.release() in finally
```

If either insert fails, the repository issues `ROLLBACK`, rethrows the original
error, and releases the client in `finally`. The project service continues to
validate input and supply the trusted actor. The repository continues to own
all SQL and transaction mechanics. The controller and route contracts do not
change.

No transaction is added to read-only count/page queries. Snapshot consistency
between their two reads remains out of scope because the user requested an
existing multi-write workflow rather than broad transaction usage.

## Audit Schema

Migration `006_project_audit_log.sql` creates `project_audit_log` with:

- `id`: generated primary key;
- `project_id`: nullable foreign key to `projects.id` using `ON DELETE SET NULL`;
- `action`: constrained to the currently supported value `created`;
- `actor_user_id`: nullable foreign key to `users.id` using `ON DELETE SET NULL`;
- `project_name`: required snapshot of the name at creation;
- `environment`: required snapshot constrained to `production` or `development`;
- `created_at`: database-generated timestamp.

The foreign keys verify referenced rows at insertion time. They are nullable so
historical audit information survives a later project or user deletion. Name
and environment snapshots keep the record understandable if `project_id`
later becomes NULL.

The table is internal. Block 3 does not add an audit API, background processing,
or additional audit actions.

The migration is additive and must not modify or remove existing data. The
existing migration history table prevents it from running twice.

## Query and Index Review

The current project-query access paths are:

- primary-key lookup by `projects.id`;
- normal-user listing by `owner_id`;
- optional low-cardinality environment filtering;
- optional literal substring search using `ILIKE '%value%'`;
- sorting by whitelisted `id`, `name`, `environment`, or `created_at` columns.

The existing primary-key index supports project ID lookup, and the existing
B-tree `owner_id` index supports the mandatory normal-user ownership predicate.
No additional project index will be added in this block:

- an environment-only index is unlikely to be selective with two values;
- a normal B-tree cannot accelerate leading-wildcard `ILIKE` searches;
- separate indexes for every allowed sort option would increase INSERT/UPDATE
  costs without evidence that those administrative queries need them;
- a composite index would duplicate the existing owner-index prefix and favor
  only some filter/sort combinations.

No PostgreSQL extension or trigram index will be introduced. Search-index
changes should wait for real query-volume and `EXPLAIN ANALYZE` evidence.

No audit-log index beyond its primary key will be added because Block 3 adds no
audit-read query. Foreign-key columns can receive indexes later when an actual
lookup or cleanup workload requires them.

## Layer Responsibilities

### Controller

Keep the existing project-create HTTP contract and pass only name, environment,
and the authenticated actor to the service.

### Service

Validate project input, ignore caller-supplied ownership fields, and derive the
owner/audit actor from `actor.userId`. Invoke the repository once for the atomic
creation operation.

### Repository

Check out one client, run `BEGIN`, both parameterized inserts, and `COMMIT`.
On failure, run `ROLLBACK`. Release the client in `finally`. Return only the
created project row; the audit record remains internal.

### Migration

Create the audit table and its database constraints without changing existing
users, projects, constraints, or indexes.

## Error Behavior

- Validation failures remain HTTP 400 and occur before connecting to the
  database.
- Authentication and authorization behavior remains HTTP 401/403 as currently
  implemented.
- A database failure in either transaction write is rolled back and continues
  through the existing generic HTTP 500 handler without leaking database
  details.
- A rollback error must not prevent client release. The original transaction
  error remains the primary error reported to the application.

## Testing

Focused unit and PostgreSQL integration tests will verify:

- successful project and audit inserts issue `BEGIN` then `COMMIT`;
- an audit failure after the project insert issues `ROLLBACK`;
- the checked-out client is released after success and failure;
- a real PostgreSQL rollback leaves neither a project nor an audit record;
- successful real PostgreSQL creation persists both rows;
- the migration applies once, preserves existing data, and creates the expected
  primary key, foreign keys, checks, and nullable relationship behavior;
- page and limit lower boundaries, a page beyond the final page, and maximum
  `limit=100` behavior;
- invalid environment, pagination, sort, and order values;
- blank search and empty result behavior;
- normal-user ownership isolation, administrator behavior, and legacy
  `owner_id = NULL` handling;
- search wildcard escaping and sort-injection resistance;
- all existing authentication, authorization, CRUD, migration, JOIN, and query
  tests.

The stable complete-suite command remains `npm test`, which runs Node's test
runner serially on this Windows environment to avoid the previously observed
worker deserialization failure.

## Scope Boundaries

Do not add Redis, background jobs, WebSockets, Docker, deployment configuration,
an audit endpoint, generalized transaction helpers, transaction-wrapped reads,
full-text search, trigram extensions, or speculative indexes.
