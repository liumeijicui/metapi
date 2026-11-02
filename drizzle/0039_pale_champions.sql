CREATE TABLE `model_batch_test_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`site_id` integer NOT NULL,
	`model_name` text NOT NULL,
	`status` text NOT NULL,
	`http_status` integer,
	`first_byte_ms` integer,
	`duration_ms` integer,
	`api_mode` text,
	`reasoning_effort` text,
	`prompt_title` text,
	`answer` text,
	`error_message` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `model_batch_test_results_run_id_idx` ON `model_batch_test_results` (`run_id`);--> statement-breakpoint
CREATE INDEX `model_batch_test_results_site_model_idx` ON `model_batch_test_results` (`site_id`,`model_name`);--> statement-breakpoint
CREATE INDEX `model_batch_test_results_http_status_idx` ON `model_batch_test_results` (`http_status`);--> statement-breakpoint
CREATE INDEX `model_batch_test_results_created_at_idx` ON `model_batch_test_results` (`created_at`);