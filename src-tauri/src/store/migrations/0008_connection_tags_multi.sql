-- Multiple tags per connection, stored as a JSON array of { name, color }.
-- The legacy single tag/tag_color columns are kept for back-compat; existing
-- rows are migrated into the new array so nothing is lost.
ALTER TABLE connections ADD COLUMN tags TEXT;

UPDATE connections
SET tags = json_array(
  json_object('name', tag, 'color', COALESCE(tag_color, 'Gray'))
)
WHERE tag IS NOT NULL AND TRIM(tag) <> '' AND (tags IS NULL OR tags = '');
