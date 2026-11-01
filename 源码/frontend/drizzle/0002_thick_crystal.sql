CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`prompt` text NOT NULL,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`workflow_version` text NOT NULL,
	`total_cost_cny` real DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cache_hit_tokens` integer DEFAULT 0 NOT NULL,
	`cache_miss_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_runs_user_created` ON `runs` (`user_id`,`created_at`);