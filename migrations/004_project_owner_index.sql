-- An index is a separate lookup structure PostgreSQL can use instead of
-- scanning every project. owner_id benefits because normal project listings
-- search with WHERE owner_id = ... as the table grows.
--
-- Indexes are not free: each one uses storage and PostgreSQL must update it on
-- INSERT, UPDATE, and DELETE. We therefore add only this current query index
-- and reuse any equivalent single-column index, even if it has another name.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_index AS index_row
        JOIN pg_attribute AS indexed_column
          ON indexed_column.attrelid = index_row.indrelid
         AND indexed_column.attnum::TEXT = index_row.indkey::TEXT
        WHERE index_row.indrelid = 'projects'::regclass
          AND index_row.indisvalid
          AND index_row.indpred IS NULL
          AND index_row.indexprs IS NULL
          AND index_row.indnkeyatts = 1
          AND indexed_column.attname = 'owner_id'
    ) THEN
        CREATE INDEX idx_projects_owner_id ON projects USING btree (owner_id);
    END IF;
END
$$;
