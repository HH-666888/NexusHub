CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_events_run_seq` ON `run_events` (`run_id`,`seq`);