UPDATE `issue_repositories`
SET `working_branch` = replace(`working_branch`, 'hotfix/', 'hotfix-'),
    `updated_at` = unixepoch() * 1000
WHERE `working_branch` LIKE 'hotfix/issue-%';

UPDATE `issue_repositories`
SET `working_branch` = replace(`working_branch`, 'feature/', 'feature-'),
    `updated_at` = unixepoch() * 1000
WHERE `working_branch` LIKE 'feature/issue-%';
