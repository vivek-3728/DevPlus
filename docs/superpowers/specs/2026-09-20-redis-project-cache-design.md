# Phase 5 Block 1 Redis Project Cache Design

## Purpose

Add Redis as an optional performance layer for `GET /api/projects/:id` while
keeping PostgreSQL authoritative and preserving every Phase 1–4 authentication,
role, and ownership rule. A Redis outage must reduce performance, not API
availability.

## Scope

This block caches only successful individual-project reads. It does not cache
the paginated project list and does not add sessions, rate limiting, queues,
Pub/Sub, background jobs, Docker, or deployment configuration.

## Dependency and configuration

Use the official `redis` Node.js client (node-redis) with CommonJS imports.
Create `src/config/redis.js` as the only module responsible for creating the
shared client and starting its connection.

Configuration comes from environment variables:

- `REDIS_URL`, with a local-development example of `redis://localhost:6379`.
  Credentials, TLS settings, and non-local hosts belong in the real environment
  value and are never committed or logged.
- `REDIS_PROJECT_TTL_SECONDS`, a positive integer. The default is 60 seconds.

The client registers an `error` listener because node-redis requires one to
prevent EventEmitter errors from terminating the process. It also observes
`ready`, `reconnecting`, and `end` events with credential-free messages.
`disableOfflineQueue` is enabled so optional cache commands fail quickly rather
than waiting while Redis is unavailable. Server startup initiates `connect()`
without waiting for Redis before accepting HTTP traffic.

## Module boundaries

`src/config/redis.js` owns connection configuration and lifecycle only.

`src/services/projectCache.js` owns cache keys, JSON serialization, TTL writes,
and invalidation. Its public operations are fail-open: Redis connection,
command, or malformed-cache errors are logged and become a cache miss or a
no-op. This behavior must never catch PostgreSQL errors because PostgreSQL calls
remain in `projectService.js` and `projectRepository.js`.

`src/services/projectService.js` keeps project validation and authorization.
It coordinates the cache-aside flow but never calls Redis commands directly.

`src/repositories/projectRepository.js` remains PostgreSQL-only. Controllers
and routes retain their existing interfaces.

## Cache keys and authorization

Keys are scoped by the authenticated actor:

```text
devpulse:project:user:{userId}:{projectId}
devpulse:project:admin:{projectId}
```

Both IDs must already be validated positive integers. `userId` comes only from
the verified JWT actor, never from query parameters, route parameters, or the
request body. Separate user and administrator namespaces prevent one role's
entry from becoming another role's authorization result.

Key scoping is defense in depth, not the authorization decision. On every cache
hit, the service also verifies that the decoded object has the requested
project ID and, for a normal user, an `owner_id` exactly equal to the JWT user
ID. Administrators keep their existing bypass. A malformed or mismatched cache
value is treated as a miss and never returned.

## Cache-aside read flow

For `GET /api/projects/:id`:

1. Validate the route ID using the existing validation rule.
2. Build the actor-scoped key from the validated ID and verified actor.
3. Ask `projectCache` for the cached project.
4. If a structurally valid cached project passes the existing authorization
   rule, return it without querying PostgreSQL.
5. On a miss, malformed entry, or Redis failure, query PostgreSQL.
6. Return 404 if PostgreSQL has no row, or 403 if the row is not authorized.
7. Only after PostgreSQL returns a successfully authorized project, serialize
   it and write it with `SET key value EX <TTL>`.
8. Return the PostgreSQL row even if the Redis write fails.

This ordering ensures 401 requests never reach the service, and 403, 404,
validation failures, Redis failures, and PostgreSQL failures are never cached.

## Invalidation

An update or deletion first completes its PostgreSQL mutation. Only after that
success, invalidate:

- `devpulse:project:admin:{projectId}`; and
- `devpulse:project:user:{ownerId}:{projectId}` when `owner_id` is non-null.

The service already reads and authorizes the existing row before update/delete;
that row supplies the immutable owner ID required to clear both actor scopes.
Legacy NULL-owned projects therefore invalidate only the administrator key.
Redis invalidation failure is logged and does not change a successful database
response. This can leave stale data until the short TTL expires, which is the
intentional availability-over-cache-consistency trade-off for this block.

Creation does not invalidate or pre-populate a cache entry because no entry for
the new database-generated ID can exist yet.

## Failure behavior

Redis is optional. A disconnected client, connection error, command rejection,
invalid JSON, or invalid cached shape becomes a cache miss/no-op. PostgreSQL is
then queried normally and its failures continue through the existing error
handler without being hidden.

The cache layer must not return stale data that fails current ID/ownership
checks. It must not retry requests in the HTTP path or wait for Redis recovery.

## Testing

Focused unit tests will replace the cache-service and repository boundaries to
prove:

- cache miss queries PostgreSQL and populates Redis with the configured TTL;
- cache hit returns without querying PostgreSQL;
- update and delete invalidate only after PostgreSQL succeeds;
- a user cannot obtain another user's or a legacy NULL-owned project through a
  cache entry;
- administrators retain their bypass using the administrator namespace;
- Redis read/write/delete failures fall back or remain non-fatal;
- 403, 404, validation failures, and PostgreSQL errors do not populate Redis;
- malformed, wrong-ID, and wrong-owner cache entries are not returned.

Configuration/cache tests will verify key format, default/configured TTL,
serialization, and disconnected-client behavior without requiring a running
Redis server. Existing HTTP, authentication, CRUD, migration, transaction, and
real PostgreSQL tests must continue to pass.

## Acceptance criteria

- PostgreSQL remains the source of truth.
- Only successful authorized single-project reads are cached.
- No cache entry can bypass ownership or role authorization.
- Successful updates/deletes trigger invalidation after the database mutation.
- Redis unavailability does not make project reads unavailable.
- The complete test suite passes.
