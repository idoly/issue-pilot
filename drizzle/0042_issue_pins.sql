CREATE TABLE `issue_pins` (
	`subject` text NOT NULL,
	`issue_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`subject`, `issue_id`),
	FOREIGN KEY (`subject`) REFERENCES `subjects`(`subject`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_pins_subject_created_idx` ON `issue_pins` (`subject`, `created_at`);
