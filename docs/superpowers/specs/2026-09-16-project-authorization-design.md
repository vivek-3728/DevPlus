# DevPulse Project Authorization Design

**Date:** 2026-09-16

## Goal

Add role authorization and project ownership to the existing DevPulse API while preserving current project data and existing authentication behavior.

Authentication answers **who the caller is**. The existing JWT middleware verifies the token and attaches `{ userId, role }` to `req.user`. Authorization answers **what that authenticated caller may do**. The new role and ownership checks run only after authentication succeeds.

## Current State

The live database contains:

- one row in `projects`;
- zero rows in `users`;
- no ownership column or foreign key on `projects`;
- a primary key on both tables;
- a unique constraint on `users.email`.

Because no user exists, the legacy project cannot be assigned to a real owner during migration. It must remain preserved and temporarily unowned.

## Database Migration

Create an idempotent SQL migration that:

1. adds nullable `projects.owner_id INTEGER` when absent;
2. adds a foreign key from `projects.owner_id` to `users.id`;
3. uses `ON DELETE SET NULL` so deleting a user preserves their projects;
4. creates an index on `projects.owner_id` for owner-filtered queries;
5. leaves the existing project unchanged with `owner_id = NULL`.

The foreign key prevents a project from referencing a nonexistent user. The nullable column is intentional for preserved legacy data. Application code always supplies an authenticated owner for new projects, so new rows created through the API are owned.

No endpoint accepts `owner_id` or `userId` from request JSON. Ownership always comes from the verified JWT through `req.user.userId`.

## Role Authorization Middleware

Create `authorizeRoles(...allowedRoles)` in the middleware folder. It reads `req.user.role`, which must already have been created by authentication middleware.

- When the role is allowed, it calls `next()`.
- When the role is absent or not allowed, it forwards an operational `403 Forbidden` error to the centralized error handler.

All project routes use this middleware with the existing roles `user` and `admin`. The factory remains reusable for an admin-only route by calling `authorizeRoles("admin")`. No additional roles are introduced.

The middleware order is:

```text
HTTP request
→ authenticate JWT
→ authorize role
→ project controller
→ project service ownership check
→ project repository
→ PostgreSQL
```

## Project Access Rules

### List projects

`GET /api/projects`

- A `user` receives only rows whose `owner_id` equals their authenticated user ID.
- An `admin` receives every project, including the legacy row whose owner is null.

### Read one project

`GET /api/projects/:id`

- A user may read their own project.
- A user receives `403` for an existing project owned by someone else or an unowned legacy project.
- An admin may read any project.
- A nonexistent project returns `404` for both roles.

### Create a project

`POST /api/projects`

- Both authenticated roles may create projects.
- The controller passes the verified `req.user` to the service.
- The repository inserts `owner_id` from `req.user.userId`.
- Request-body owner fields are ignored because the controller extracts only `name` and `environment`.

### Update a project

`PUT /api/projects/:id`

- A user may update their own project.
- A user receives `403` for another user's or an unowned project.
- An admin may update any project.
- Only `name` and `environment` change; ownership cannot be transferred through this endpoint.

### Delete a project

`DELETE /api/projects/:id`

- A user may delete their own project.
- A user receives `403` for another user's or an unowned project.
- An admin may delete any project.
- Successful deletion keeps the existing `204 No Content` response.

## Layer Responsibilities

### Routes

Apply `authenticate` first and `authorizeRoles("user", "admin")` second to every project route. Routes choose middleware and controllers but do not query the database or implement ownership logic.

### Controllers

Read URL/body data, pass `req.user` to project services, and format HTTP responses. Controllers never accept ownership from `req.body`.

### Services

Validate project input and IDs, choose the correct list query for the caller's role, and enforce owner-or-admin access for individual projects. A shared internal ownership check throws `403` for existing inaccessible projects.

### Repositories

Use parameterized SQL. Add owner-filtered listing and insert `owner_id` with new projects. Existing update and delete queries continue changing only the requested fields after service authorization.

## Error Behavior

- Missing, invalid, or expired JWT: `401` from authentication middleware.
- Authenticated role not allowed: `403` from role middleware.
- Existing project owned by someone else or unowned for a normal user: `403` from the project service.
- Missing project: `404` from the project service.
- Invalid ID or project input: existing `400` behavior.
- Unexpected database/internal failure: existing generic `500` behavior.

Admins bypass project ownership checks, but they still pass JWT authentication, allowed-role middleware, ID validation, input validation, and normal missing-project handling.

## Tests

Update existing project HTTP tests to authenticate requests because project routes intentionally become protected. Preserve all CRUD validation and database-failure tests.

Add focused coverage for:

- requests without JWT returning `401`;
- role middleware allowing configured roles;
- a normal user receiving `403` from admin-only middleware;
- owner list/read/update/delete access;
- another user receiving `403`;
- a normal user receiving `403` for the legacy unowned project;
- admin listing and managing owned or unowned projects;
- project creation using the authenticated ID even when the body contains an owner-like field;
- parameterized owner queries;
- migration schema, foreign key, index, and preserved legacy row;
- all existing registration, login, `/me`, health, and project validation behavior.

## Migration Verification and Rollback

After applying the migration, inspect `information_schema`, PostgreSQL constraints, indexes, and the existing project row. The expected legacy row count remains one and its `owner_id` is null.

The migration is additive and data-preserving. A rollback, if required before owned projects are created, removes the index, foreign key, and owner column. Once owned projects exist, rollback would discard ownership metadata and therefore must require an explicit data decision rather than run automatically.

## Scope Exclusions

This work does not add new roles, project ownership transfer, role-management endpoints, JWT changes, login changes, refresh tokens, or other unrelated features.
