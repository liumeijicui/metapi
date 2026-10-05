CREATE TABLE `prompt_cases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`suite_id` integer NOT NULL,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`expected_answer` text,
	`answer_notes` text,
	`judge_mode` text DEFAULT 'manual' NOT NULL,
	`tags` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`suite_id`) REFERENCES `prompt_suites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_cases_suite_title_unique` ON `prompt_cases` (`suite_id`,`title`);--> statement-breakpoint
CREATE INDEX `prompt_cases_suite_id_idx` ON `prompt_cases` (`suite_id`);--> statement-breakpoint
CREATE INDEX `prompt_cases_enabled_idx` ON `prompt_cases` (`enabled`);--> statement-breakpoint
CREATE TABLE `prompt_suites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`category` text,
	`source_url` text,
	`tags` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_suites_slug_unique` ON `prompt_suites` (`slug`);--> statement-breakpoint
CREATE INDEX `prompt_suites_category_idx` ON `prompt_suites` (`category`);