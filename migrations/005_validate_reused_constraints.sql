-- Earlier migrations intentionally reuse constraints that may have been added
-- manually under another name. This follow-up migration is separate because
-- migrations 001-004 may already be recorded in an existing database and must
-- remain immutable after deployment.
DO $$
DECLARE
    constraint_to_validate RECORD;
    environment_attribute SMALLINT;
    new_environment_constraint_name TEXT;
BEGIN
    -- A NOT VALID foreign key checks future writes but has not checked old
    -- rows. Validate every otherwise-correct ownership foreign key so migration
    -- success means legacy owner IDs also reference real users.
    FOR constraint_to_validate IN
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
          AND constraint_row.confdeltype = 'n'
          AND NOT constraint_row.convalidated
    LOOP
        EXECUTE format(
            'ALTER TABLE projects VALIDATE CONSTRAINT %I',
            constraint_to_validate.conname
        );
    END LOOP;

    SELECT attnum
    INTO environment_attribute
    FROM pg_attribute
    WHERE attrelid = 'projects'::regclass
      AND attname = 'environment'
      AND NOT attisdropped;

    -- Compare the complete normalized form PostgreSQL produces for the exact
    -- two-value IN rule. Merely finding both words would incorrectly reuse a
    -- weaker rule such as production/development/qa or an opposite NOT IN rule.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'projects'::regclass
          AND contype = 'c'
          AND conkey = ARRAY[environment_attribute]::SMALLINT[]
          AND regexp_replace(
              regexp_replace(
                  lower(pg_get_constraintdef(oid)),
                  '\s+',
                  '',
                  'g'
              ),
              'notvalid$',
              ''
          ) IN (
              'check(((environment)::text=any((array[''production''::charactervarying,''development''::charactervarying])::text[])))',
              'check(((environment)::text=any((array[''development''::charactervarying,''production''::charactervarying])::text[])))'
          )
    ) THEN
        -- If a weaker manually-created constraint already uses the preferred
        -- name, choose a clear fallback rather than dropping that user-owned
        -- constraint or failing because names collide.
        IF EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'projects'::regclass
              AND conname = 'projects_environment_check'
        ) THEN
            new_environment_constraint_name := 'projects_environment_allowed_values_check';
        ELSE
            new_environment_constraint_name := 'projects_environment_check';
        END IF;

        EXECUTE format(
            'ALTER TABLE projects ADD CONSTRAINT %I CHECK (environment IN (''production'', ''development''))',
            new_environment_constraint_name
        );
    END IF;

    -- Validate an exact reused check when it was created with NOT VALID. Any
    -- unsupported legacy value aborts this migration transaction without being
    -- changed, and the migration filename is not recorded.
    FOR constraint_to_validate IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'projects'::regclass
          AND contype = 'c'
          AND conkey = ARRAY[environment_attribute]::SMALLINT[]
          AND NOT convalidated
          AND regexp_replace(
              regexp_replace(
                  lower(pg_get_constraintdef(oid)),
                  '\s+',
                  '',
                  'g'
              ),
              'notvalid$',
              ''
          ) IN (
              'check(((environment)::text=any((array[''production''::charactervarying,''development''::charactervarying])::text[])))',
              'check(((environment)::text=any((array[''development''::charactervarying,''production''::charactervarying])::text[])))'
          )
    LOOP
        EXECUTE format(
            'ALTER TABLE projects VALIDATE CONSTRAINT %I',
            constraint_to_validate.conname
        );
    END LOOP;
END
$$;
