CREATE TABLE IF NOT EXISTS `model_batch_test_results` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `run_id` TEXT NOT NULL, `site_id` INT NOT NULL, `model_name` TEXT NOT NULL, `status` TEXT NOT NULL, `http_status` INT, `first_byte_ms` INT, `duration_ms` INT, `api_mode` TEXT, `reasoning_effort` TEXT, `prompt_title` TEXT, `answer` TEXT, `error_message` TEXT, `created_at` VARCHAR(191) NOT NULL, FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE);
CREATE INDEX `model_batch_test_results_created_at_idx` ON `model_batch_test_results` (`created_at`);
CREATE INDEX `model_batch_test_results_http_status_idx` ON `model_batch_test_results` (`http_status`);
CREATE INDEX `model_batch_test_results_run_id_idx` ON `model_batch_test_results` (`run_id`(191));
CREATE INDEX `model_batch_test_results_site_model_idx` ON `model_batch_test_results` (`site_id`, `model_name`(191));
