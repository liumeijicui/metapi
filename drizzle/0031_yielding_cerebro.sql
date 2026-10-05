CREATE TABLE `model_forward_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_name` text NOT NULL,
	`enabled` integer DEFAULT true,
	`route_id` integer,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_forward_rules_model_name_unique` ON `model_forward_rules` (`model_name`);--> statement-breakpoint
CREATE INDEX `model_forward_rules_enabled_idx` ON `model_forward_rules` (`enabled`);--> statement-breakpoint
CREATE INDEX `model_forward_rules_route_id_idx` ON `model_forward_rules` (`route_id`);--> statement-breakpoint
CREATE TABLE `model_forward_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_id` integer NOT NULL,
	`site_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`token_id` integer,
	`upstream_model` text NOT NULL,
	`channel_id` integer,
	`weight` integer DEFAULT 10,
	`enabled` integer DEFAULT true,
	`sort_order` integer DEFAULT 0,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`rule_id`) REFERENCES `model_forward_rules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`token_id`) REFERENCES `account_tokens`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_forward_targets_rule_account_model_unique` ON `model_forward_targets` (`rule_id`,`account_id`,`upstream_model`);--> statement-breakpoint
CREATE INDEX `model_forward_targets_rule_sort_idx` ON `model_forward_targets` (`rule_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `model_forward_targets_site_id_idx` ON `model_forward_targets` (`site_id`);--> statement-breakpoint
CREATE INDEX `model_forward_targets_account_id_idx` ON `model_forward_targets` (`account_id`);--> statement-breakpoint
CREATE INDEX `model_forward_targets_channel_id_idx` ON `model_forward_targets` (`channel_id`);