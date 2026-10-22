CREATE TABLE `artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_artifacts_run` ON `artifacts` (`run_id`,`created_at`);