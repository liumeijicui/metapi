CREATE TABLE `admin_login_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text,
	`ip` text NOT NULL,
	`user_agent` text,
	`success` integer DEFAULT false NOT NULL,
	`reason` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `admin_login_logs_created_at_idx` ON `admin_login_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `admin_login_logs_ip_created_at_idx` ON `admin_login_logs` (`ip`,`created_at`);--> statement-breakpoint
CREATE INDEX `admin_login_logs_success_created_at_idx` ON `admin_login_logs` (`success`,`created_at`);--> statement-breakpoint
CREATE TABLE `ip_blocklist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ip` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`blocked_at` text DEFAULT (datetime('now')),
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ip_blocklist_ip_unique` ON `ip_blocklist` (`ip`);--> statement-breakpoint
CREATE INDEX `ip_blocklist_blocked_at_idx` ON `ip_blocklist` (`blocked_at`);--> statement-breakpoint
CREATE INDEX `ip_blocklist_source_idx` ON `ip_blocklist` (`source`);