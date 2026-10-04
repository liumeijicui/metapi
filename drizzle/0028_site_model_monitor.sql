CREATE TABLE `site_model_monitor_models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`model_name` text NOT NULL,
	`avg_latency_ms` real,
	`success_rate` real,
	`avg_tps` real,
	`recent_success` text,
	`window_start` integer,
	`window_end` integer,
	`show_throughput` integer,
	`fetched_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_model_monitor_models_site_model_unique` ON `site_model_monitor_models` (`site_id`,`model_name`);--> statement-breakpoint
CREATE INDEX `site_model_monitor_models_site_id_idx` ON `site_model_monitor_models` (`site_id`);--> statement-breakpoint
CREATE INDEX `site_model_monitor_models_model_name_idx` ON `site_model_monitor_models` (`model_name`);--> statement-breakpoint
CREATE TABLE `site_model_monitor_sites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`message` text,
	`models_count` integer DEFAULT 0 NOT NULL,
	`credential_kind` text,
	`credential_id` integer,
	`show_throughput` integer,
	`summary_avg_latency_ms` real,
	`summary_success_rate` real,
	`summary_avg_tps` real,
	`window_start` integer,
	`window_end` integer,
	`fetched_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_model_monitor_sites_site_unique` ON `site_model_monitor_sites` (`site_id`);--> statement-breakpoint
CREATE INDEX `site_model_monitor_sites_status_idx` ON `site_model_monitor_sites` (`status`);