ALTER TABLE repositories ADD COLUMN repository_group TEXT NOT NULL DEFAULT 'other'
  CONSTRAINT repository_group_valid CHECK (length(repository_group) BETWEEN 1 AND 64 AND trim(repository_group) = repository_group);
--> statement-breakpoint
-- Preserve the old list filter once. Future grouping is independent of the repository address.
WITH addresses AS (
  SELECT id, lower(url) AS url,
    CASE
      WHEN lower(url) LIKE 'https://%' THEN substr(lower(url), 9)
      WHEN lower(url) LIKE 'ssh://%' THEN substr(lower(url), 7)
    END AS authority_and_path
  FROM repositories
), parts AS (
  SELECT id, authority_and_path, substr(url, 1, instr(url, ':') - 1) AS scp_authority,
    substr(url, instr(url, ':') + 1) AS scp_path
  FROM addresses
), paths AS (
  SELECT id, CASE
    WHEN instr(authority_and_path, '/') > 1 THEN substr(authority_and_path, instr(authority_and_path, '/') + 1)
    WHEN authority_and_path IS NULL AND instr(scp_authority, '@') > 1
      AND substr(scp_authority, instr(scp_authority, '@') + 1) <> ''
      AND substr(scp_authority, 1, instr(scp_authority, '@') - 1) NOT GLOB '*[^a-z0-9_.-]*'
      AND substr(scp_authority, instr(scp_authority, '@') + 1) NOT GLOB '*[^a-z0-9_.-]*'
      THEN substr(scp_path, CASE WHEN scp_path LIKE '/%' THEN 2 ELSE 1 END)
  END AS path FROM parts
), project_paths AS (
  SELECT id, substr(path, length('digital-biz-projects/') + 1) AS path
  FROM paths WHERE substr(path, 1, length('digital-biz-projects/')) = 'digital-biz-projects/'
), namespaces AS (
  SELECT id, substr(path, 1, instr(path, '/') - 1) AS namespace
  FROM project_paths WHERE instr(path, '/') > 1 AND substr(path, instr(path, '/') + 1, 1) NOT IN ('', '/')
), groups AS (
  SELECT id, CASE namespace WHEN 'xhgj-mall' THEN 'mall' ELSE namespace END AS repository_group
  FROM namespaces WHERE namespace IN ('oms', 'srm', 'xhgj-mall', 'mdm', 'crm', 'iqs', 'mpm')
)
UPDATE repositories SET repository_group = groups.repository_group FROM groups WHERE repositories.id = groups.id;
