-- Application validation gives clients a friendly error, but a database CHECK
-- protects the rule no matter which script or tool writes the row. PostgreSQL
-- validates existing rows before accepting this constraint; invalid legacy
-- data therefore stops the migration instead of being silently rewritten.
DO $$
DECLARE
    environment_attribute SMALLINT;
BEGIN
    SELECT attnum
    INTO environment_attribute
    FROM pg_attribute
    WHERE attrelid = 'projects'::regclass
      AND attname = 'environment'
      AND NOT attisdropped;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'projects'::regclass
          AND contype = 'c'
          AND conkey = ARRAY[environment_attribute]::SMALLINT[]
          AND pg_get_constraintdef(oid) ILIKE '%production%'
          AND pg_get_constraintdef(oid) ILIKE '%development%'
          AND pg_get_constraintdef(oid) NOT ILIKE '%staging%'
    ) THEN
        ALTER TABLE projects
        ADD CONSTRAINT projects_environment_check
        CHECK (environment IN ('production', 'development'));
    END IF;
END
$$;
