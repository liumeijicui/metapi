CREATE TABLE `fingerprint_blocklist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fingerprint` text NOT NULL,
	`label` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`last_ip` text,
	`last_user_agent` text,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`blocked_at` text DEFAULT (datetime('now')),
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fingerprint_blocklist_fingerprint_unique` ON `fingerprint_blocklist` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `fingerprint_blocklist_blocked_at_idx` ON `fingerprint_blocklist` (`blocked_at`);--> statement-breakpoint
CREATE INDEX `fingerprint_blocklist_source_idx` ON `fingerprint_blocklist` (`source`);