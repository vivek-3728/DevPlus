-- The owner column is intentionally nullable. Projects created before
-- ownership existed have no truthful user to reference, so NULL preserves
-- those legacy rows instead of inventing or deleting data.
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS owner_id INTEGER;

DO $$
DECLARE
    old_constraint RECORD;
BEGIN
    -- Remove only owner->user foreign keys that have the wrong deletion rule.
    -- Constraint names can differ when a database was changed manually, so we
    -- compare the columns and referenced table instead of only comparing names.
    FOR old_constraint IN
        SELECT constraint_row.conname
        FROM pg_constraint AS constraint_row
        JOIN pg_attribute AS project_column
          ON project_column.attrelid = constraint_row.conrelid
         AND project_column.attnum = constraint_row.conkey[1]
        JOIN pg_attribute AS user_column
          ON user_column.attrelid = constraint_row.confrelid
         AND user_column.attnum = constraint_row.confkey[1]
        WHERE constraint_row.conrelid = 'projects'::regclass
          AND constraint_row.contype = 'f'
          AND cardinality(constraint_row.conkey) = 1
          AND cardinality(constraint_row.confkey) = 1
          AND project_column.attname = 'owner_id'
          AND constraint_row.confrelid = 'users'::regclass
          AND user_column.attname = 'id'
          AND constraint_row.confdeltype <> 'n'
    LOOP
        EXECUTE format(
            'ALTER TABLE projects DROP CONSTRAINT %I',
            old_constraint.conname
        );
    END LOOP;

    -- A foreign key provides referential integrity: a non-NULL owner_id must
    -- name a real users.id. ON DELETE SET NULL keeps the project when its user
    -- is deleted and accurately records that it is no longer owned.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint AS constraint_row
        JOIN pg_attribute AS project_column
          ON project_column.attrelid = constraint_row.conrelid
         AND project_column.attnum = constraint_row.conkey[1]
        JOIN pg_attribute AS user_column
          ON user_column.attrelid = constraint_row.confrelid
         AND user_column.attnum = constraint_row.confkey[1]
        WHERE constraint_row.conrelid = 'projects'::regclass
          AND constraint_row.contype = 'f'
          AND cardinality(constraint_row.conkey) = 1
          AND cardinality(constraint_row.confkey) = 1
          AND project_column.attname = 'owner_id'
          AND constraint_row.confrelid = 'users'::regclass
          AND user_column.attname = 'id'
          AND constraint_row.confdeltype = 'n'
    ) THEN
        ALTER TABLE projects
        ADD CONSTRAINT projects_owner_id_fkey
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END
$$;
