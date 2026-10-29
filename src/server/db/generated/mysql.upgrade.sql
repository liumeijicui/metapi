CREATE TABLE IF NOT EXISTS `model_probe_results` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `site_id` INT NOT NULL, `model_name` TEXT NOT NULL, `source` TEXT NOT NULL, `status` TEXT NOT NULL, `first_byte_ms` INT, `duration_ms` INT, `api_mode` TEXT, `reasoning_effort` TEXT, `answer` TEXT, `error_message` TEXT, `created_at` VARCHAR(191) NOT NULL, FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE);
CREATE UNIQUE INDEX `model_probe_results_site_model_unique` ON `model_probe_results` (`site_id`, `model_name`(191));
CREATE INDEX `model_probe_results_created_at_idx` ON `model_probe_results` (`created_at`);
CREATE INDEX `model_probe_results_site_id_idx` ON `model_probe_results` (`site_id`);
