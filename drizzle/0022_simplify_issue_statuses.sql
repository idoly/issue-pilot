UPDATE `issues` SET `status` = 'open' WHERE `status` = 'failed';--> statement-breakpoint
UPDATE `issues` SET `status` = 'resolved' WHERE `status` = 'closed';
