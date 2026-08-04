ALTER TABLE `service_repositories` ADD `kind` text DEFAULT 'backend' NOT NULL;
--> statement-breakpoint
UPDATE `service_repositories`
SET `kind` = 'frontend'
WHERE lower(`url`) LIKE '%/fronts/%'
   OR lower(`url`) LIKE '%-front.git%'
   OR lower(`url`) LIKE '%-frontend.git%';
