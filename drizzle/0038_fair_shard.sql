CREATE TABLE `model_probe_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`model_name` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`first_byte_ms` integer,
	`duration_ms` integer,
	`api_mode` text,
	`reasoning_effort` text,
	`answer` text,
	`error_message` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_probe_results_site_model_unique` ON `model_probe_results` (`site_id`,`model_name`);--> statement-breakpoint
CREATE INDEX `model_probe_results_site_id_idx` ON `model_probe_results` (`site_id`);--> statement-breakpoint
CREATE INDEX `model_probe_results_created_at_idx` ON `model_probe_results` (`created_at`);