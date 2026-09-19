# DevPulse Phase 4 Block 2: Advanced Project Querying Design

**Date:** 2026-09-19

## Goal

Restore the missing Phase 3 project authentication, role authorization, and
ownership enforcement, then add safe pagination, environment filtering,
case-insensitive name search, and sorting to `GET /api/projects`.

The resulting endpoint must never reveal another user's projects through rows,
counts, pages, searches, or filters. Existing project CRUD behavior remains
available behind the restored authorization rules.

## Current State and Required Prerequisite

The database already contains the Phase 4 Block 1 ownership column, foreign
key, environment constraint, indexes, migration history, and project/owner
JOIN. Authentication middleware exists and attaches trusted `{ userId, role }`
from a verified JWT.

The current project routes and project application layers do not contain the
Phase 3 behavior described by the existing authorization design:

- project routes do not run authentication or role authorization middleware;
- controllers do not pass `req.user` into project services;
- project creation does not write `owner_id`;
- list/read/update/delete do not enforce owner-or-admin access.

The user explicitly authorized restoring these missing prerequisites before
adding Block 2. The existing database schema and migrations remain unchanged.

## HTTP Contract

All `/api/projects` routes require a valid Bearer JWT and a role of `user` or
`admin`.

`GET /api/projects` accepts these optional query parameters:

| Parameter | Default | Valid values |
| --- | --- | --- |
| `page` | `1` | positive decimal safe integer |
| `limit` | `10` | positive decimal safe integer, maximum `100` |
| `environment` | none | `production` or `development` |
| `search` | none | nonblank text after trimming, maximum 100 characters |
| `sort` | `id` | `id`, `name`, `environment`, `created_at` |
| `order` | `asc` | `asc` or `desc`, case-insensitive input normalized lowercase |

Unknown query parameters are ignored so future clients can add unrelated URL
parameters without breaking this endpoint. Repeated parameters arrive from
Express as arrays and are rejected because the endpoint expects one value per
supported option.

An empty or whitespace-only `search` is treated as absent rather than matching
every row. Search text longer than 100 characters returns HTTP 400.

Successful responses always use this shape:

```json
{
  "page": 1,
  "limit": 10,
  "total": 0,
  "totalPages": 0,
  "projects": []
}
```

`total` is the number of authorized projects after environment/search filters
but before pagination. `totalPages` is `Math.ceil(total / limit)` and is zero
when `total` is zero. A valid page beyond the final page returns an empty
`projects` array while preserving the correct total metadata.

## Authorization and Ownership

Project route middleware runs in this order:

```text
authenticate JWT -> authorize user/admin role -> controller -> service -> repository
```

The controller passes the trusted `req.user` object into every project service
operation. It never accepts owner IDs from query parameters or JSON bodies.

- Normal users list only rows where `projects.owner_id` equals their JWT user
  ID. This ownership predicate is included in both the count query and the page
  query before search, filtering, sorting, limit, or offset.
- Admins omit the ownership predicate and can list all projects, including
  legacy rows whose `owner_id` is null.
- Normal users receive HTTP 403 when reading, updating, or deleting an existing
  project they do not own, including a null-owner legacy project.
- Admins may read, update, or delete any project.
- A missing project returns HTTP 404 for either role.
- New projects always write `owner_id` from `req.user.userId`; body fields such
  as `owner_id` and `userId` are ignored.
- Updating a project changes only name and environment. Ownership transfer is
  not part of this endpoint.

Authentication answers who the caller is; the service layer owns the
owner-or-admin policy; the repository owns SQL and applies the already-decided
list scope.

## Query Validation

The service converts raw Express query values into one normalized query object:

```js
{
    page,
    limit,
    offset,
    environment,
    search,
    sort,
    order
}
```

Page and limit accept only strings containing decimal digits. Zero, negatives,
fractions, exponent notation, hexadecimal notation, unsafe integers, arrays,
objects, and values above the limit maximum return HTTP 400.

Environment validation reuses the same allowed-value helper used by project
create/update validation. Sorting and order are selected from fixed sets. The
service passes normalized values rather than raw request data to the repository.

## Repository Query Construction

The repository provides an owner-aware query function that returns:

```js
{ projects, total }
```

It builds a list of fixed SQL predicates and a separate values array. Every
caller-controlled value—owner ID, environment, search pattern, limit, and
offset—uses a PostgreSQL `$n` placeholder.

Search uses `ILIKE` for case-insensitive matching. `%`, `_`, and `\` in user
search text are escaped and the SQL uses an explicit escape character, so
search means a literal substring rather than letting user text introduce extra
wildcard behavior.

Sorting is the only part that cannot use a PostgreSQL value placeholder because
column names and `ASC`/`DESC` are SQL syntax. The repository therefore maps
already-validated keys to hard-coded fragments:

```js
const SORT_COLUMNS = {
    id: "p.id",
    name: "p.name",
    environment: "p.environment",
    created_at: "p.created_at"
};
```

Order maps to the literal `ASC` or `DESC`. Raw query text is never concatenated
into SQL. `p.id ASC` is appended as a deterministic tie-breaker when another
sort column is selected, so rows with equal names/environments/timestamps do
not jump between pages.

The repository issues two queries without introducing an application
transaction:

1. `COUNT(*)` with the ownership/environment/search predicates;
2. an explicit-column `SELECT` with identical predicates, safe ordering,
   `LIMIT`, and `OFFSET`.

Separate queries allow a page beyond the result set to return an empty array
and still report the correct total. Snapshot consistency between these reads is
deferred with the requested transaction block.

## Layer Responsibilities

### Route

Apply `authenticate` and `authorizeRoles("user", "admin")` before every
project controller.

### Controller

Pass `req.query` and `req.user` to the list service. Pass `req.user` to the
remaining project services. Translate service results to the existing HTTP
status codes without containing validation, ownership, or SQL logic.

### Service

Validate and normalize query parameters, compute offset and total pages, select
admin versus owner scope, and enforce owner-or-admin policy for single-project
operations.

### Repository

Contain all SQL, apply the normalized query predicates, count and page rows,
insert trusted ownership, and retain existing CRUD methods.

## Error Behavior

Invalid supported query parameters return an operational HTTP 400 with a clear
message. Missing/invalid JWTs remain HTTP 401. Disallowed roles and ownership
violations return HTTP 403. Missing projects remain HTTP 404. Database details
remain hidden behind the existing generic HTTP 500 response.

## Testing

Use Node's built-in test runner and focused tests at service, repository, and
HTTP boundaries.

Tests cover:

- restored JWT and role middleware on every project route;
- owner ID derived only from the verified JWT during creation;
- user/admin/null-owner read, update, and delete behavior;
- default and explicit pagination metadata;
- rejected page/limit edge cases and maximum limit;
- environment filtering and invalid environment;
- case-insensitive literal-substring search;
- ASC/DESC sorting and invalid/injection-like sort/order values;
- combined query parameters and correct placeholder order;
- ownership predicates in both count and page SQL;
- admins omitting ownership filters and seeing null-owner rows;
- empty results and pages beyond the final page;
- real PostgreSQL combined-query behavior in an isolated schema;
- all existing authentication, CRUD, migration, constraint, index, and JOIN
  tests after their project-route expectations are updated for authentication
  and the new response shape.

## Scope Boundaries

Do not add Redis, caching, application transactions, new database migrations,
new project fields, full-text search, fuzzy search, ownership transfer, or a
new admin endpoint. Do not expose the Block 1 project/owner JOIN through HTTP.
