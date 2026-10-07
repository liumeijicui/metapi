ALTER TABLE `route_channels` ADD `consecutive_upstream_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `route_channels` ADD `auto_demoted_at` text;--> statement-breakpoint
ALTER TABLE `route_channels` ADD `priority_before_auto_demotion` integer;