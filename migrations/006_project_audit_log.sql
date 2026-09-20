-- The audit row is a required companion to project creation. Snapshot fields
-- preserve useful history even if the referenced user or project is deleted.
CREATE TABLE project_audit_log (
    id BIGSERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    action VARCHAR(20) NOT NULL
        CONSTRAINT project_audit_log_action_check CHECK (action = 'created'),
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    project_name VARCHAR(100) NOT NULL,
    environment VARCHAR(50) NOT NULL
        CONSTRAINT project_audit_log_environment_check
        CHECK (environment IN ('production', 'development')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- No extra index is added yet. Indexes speed reads but add work to every
-- INSERT/UPDATE/DELETE, and DevPulse has no audit-log lookup query today.
