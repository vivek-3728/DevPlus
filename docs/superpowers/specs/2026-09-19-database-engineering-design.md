# DevPulse Phase 4 Block 1: Database Engineering Design

**Date:** 2026-09-19

## Goal

Introduce a lightweight, repeatable PostgreSQL migration system; enforce the
current DevPulse data model at database level; add only useful indexes; and
provide an internal repository query that joins projects to safe owner data.
Existing users, projects, authentication behavior, and ownership authorization
must be preserved.

## Current State

The project connects to PostgreSQL through a shared `pg` pool and has no
migration runner or migration history table. The live database currently has:

- `users` with an integer primary key, required name/email/password hash/role,
  a default `user` role, and a unique constraint on email;
- `projects` with an integer primary key, required name/environment, and a
  timestamp default;
- the indexes PostgreSQL created for both primary keys and the unique email;
- no `projects.owner_id` column, ownership foreign key, or owner index;
- no database check constraint for project environment;
- zero users and one legacy project whose environment is `development`.

The existing working tree contains uncommitted Phase 1–3 code. This work must
not overwrite, reformat, or otherwise absorb unrelated changes.

## Migration Architecture

Use a custom CommonJS Node.js runner built on the project's existing `pg`
dependency. SQL migrations live in a top-level `migrations` directory and use
zero-padded filenames so lexicographic order is migration order.

The runner creates a `schema_migrations` metadata table if it is missing. Each
row records one unique migration filename and its application timestamp. For
each pending migration, the runner:

1. begins a PostgreSQL transaction;
2. executes the migration SQL;
3. records the filename in `schema_migrations`;
4. commits both changes together;
5. rolls back both changes if either step fails.

The runner holds a PostgreSQL advisory lock while checking and applying
migrations. This prevents two deployments from racing to apply the same file.
It always releases its client and closes the pool when run as the command-line
entry point. The runner also exports testable functions so tests can supply a
dedicated pool.

Applied migrations are skipped rather than rerun. Existing databases have no
history rows, so the initial migrations must also be structurally idempotent:
they inspect PostgreSQL catalog state or use safe `IF NOT EXISTS` operations and
never recreate an existing table.

`npm run migrate` invokes the runner. A successful run reports applied and
skipped filenames in beginner-friendly language.

## Migrations

### 001: Baseline current schema

Represent the `users` and `projects` tables as they exist today. Use `CREATE
TABLE IF NOT EXISTS` so a fresh database receives the current base schema while
the live database and its rows remain untouched.

The baseline contains the existing primary keys, non-null columns, timestamp
defaults, role default, and unique email constraint. It does not rebuild or
rename an existing object.

### 002: Project ownership

Add nullable `projects.owner_id INTEGER` when absent. Add a foreign key to
`users(id)` with `ON DELETE SET NULL` when an equivalent foreign key does not
already exist.

The column remains nullable by design. Existing legacy projects therefore stay
in place with `owner_id = NULL`. Deleting a user also preserves their projects
and clears the reference. No migration deletes or rewrites user/project rows.

### 003: Project environment constraint

Add a check constraint permitting only `production` or `development`, unless
an equivalent constraint already exists. Existing invalid data is not silently
changed or deleted; if such data exists, PostgreSQL rejects the migration and
the transaction rolls back with an actionable error.

### 004: Project lookup indexes

Create a B-tree index on `projects.owner_id` unless an equivalent single-column
index already exists. Owner-scoped project listing uses this column in its
`WHERE` clause, so the index can avoid scanning every project as the table
grows.

Do not add indexes for `projects.id`, `users.id`, or `users.email`: PostgreSQL
already created them for the primary-key and unique constraints. Do not add an
environment-only index because the current application does not query projects
by environment and the column has very low cardinality.

Migration comments explain that an index is a separate lookup structure that
can speed reads, but every extra index consumes storage and must be maintained
during inserts and updates.

## Constraint Compatibility

Before adding named constraints, migrations detect equivalent semantics rather
than relying only on a preferred name. This prevents duplicate constraints on
databases where pgAdmin or an earlier phase used a different name.

The expected model after migration is:

- `users.id`: existing primary key;
- `users.email`: existing unique constraint;
- `projects.id`: existing primary key;
- `projects.owner_id`: nullable foreign key to `users.id`, `ON DELETE SET NULL`;
- `projects.environment`: check constraint allowing `production` and
  `development` only.

## Safe Owner JOIN

Add `getProjectsWithOwners()` to the project repository. It uses a `LEFT JOIN`
from `projects` to `users`, ordered by project ID. A left join is required
because it keeps legacy projects whose `owner_id` is null; their owner fields
are returned as null.

The query selects explicit columns and returns this shape:

```js
{
    project_id,
    project_name,
    environment,
    owner_id,
    owner_name,
    owner_email
}
```

It never uses `SELECT *` and never selects `password_hash`. The function is an
admin/internal repository capability only. This block does not expose a new
HTTP route or change existing authentication or ownership decisions.

## Testing

Use Node's built-in test runner. Repository unit tests replace the shared
pool's query method only long enough to inspect the JOIN SQL and returned rows.
They verify the left join, selected aliases, null-owner behavior, ordering, and
absence of `password_hash`.

PostgreSQL integration tests use a uniquely named temporary schema in the
configured test database. They set the connection search path to that schema,
run real migrations, and always drop only that verified schema during cleanup.
The tests verify:

- a first migration run applies every migration and a second run skips them;
- migration history is recorded exactly once;
- a pre-existing project row survives with null ownership;
- primary keys and unique email remain enforced;
- invalid project environments are rejected;
- nonexistent owners are rejected by the foreign key;
- deleting an owner sets the project's owner to null;
- the owner index exists without duplicating built-in indexes;
- the real JOIN returns safe owner data and preserves a legacy null-owner row;
- no joined row exposes `password_hash`.

If PostgreSQL is unavailable, database integration tests must fail with a clear
configuration/connection error rather than silently skip, because this block's
core guarantees require real PostgreSQL behavior.

Finally, run the entire existing `npm test` suite after the focused tests.

## Scope Boundaries

This block does not implement pagination, filtering, sorting, search, Redis,
application transaction features, new HTTP endpoints, or ownership-policy
changes. Transactions used internally by the migration runner are necessary
for safe schema application and do not constitute the deferred application
transaction feature.

No down migration is provided for these additive baseline changes. Removing an
ownership column or constraint could discard metadata or weaken integrity, so
rollback requires an explicit future data decision rather than an automatic
destructive command.
