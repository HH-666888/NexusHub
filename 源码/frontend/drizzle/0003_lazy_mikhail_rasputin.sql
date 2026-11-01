CREATE TABLE `cost_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text,
	`stage` text,
	`node_id` text,
	`tier` text NOT NULL,
	`model` text NOT NULL,
	`purpose` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`reasoning_tokens` integer NOT NULL,
	`cache_hit_tokens` integer NOT NULL,
	`cache_miss_tokens` integer NOT NULL,
	`cost_cny` real NOT NULL,
	`price_tier` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cost_run` ON `cost_records` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_cost_created` ON `cost_records` (`created_at`);