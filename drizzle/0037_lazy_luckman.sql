CREATE TABLE `trusted_fingerprints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fingerprint` text NOT NULL,
	`label` text,
	`note` text,
	`last_ip` text,
	`last_user_agent` text,
	`last_seen_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trusted_fingerprints_fingerprint_unique` ON `trusted_fingerprints` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `trusted_fingerprints_created_at_idx` ON `trusted_fingerprints` (`created_at`);