CREATE TABLE IF NOT EXISTS `prompt_suites` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `name` TEXT NOT NULL, `slug` TEXT NOT NULL, `description` TEXT, `category` TEXT, `source_url` TEXT, `tags` TEXT, `sort_order` INT NOT NULL DEFAULT 0, `created_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')), `updated_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')));
CREATE TABLE IF NOT EXISTS `prompt_cases` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `suite_id` INT NOT NULL, `title` TEXT NOT NULL, `prompt` TEXT NOT NULL, `expected_answer` TEXT, `answer_notes` TEXT, `judge_mode` VARCHAR(191) NOT NULL DEFAULT 'manual', `tags` TEXT, `sort_order` INT NOT NULL DEFAULT 0, `enabled` BOOLEAN NOT NULL DEFAULT true, `created_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')), `updated_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')), FOREIGN KEY (`suite_id`) REFERENCES `prompt_suites`(`id`) ON DELETE CASCADE);
CREATE UNIQUE INDEX `prompt_cases_suite_title_unique` ON `prompt_cases` (`suite_id`, `title`(191));
CREATE UNIQUE INDEX `prompt_suites_slug_unique` ON `prompt_suites` (`slug`(191));
CREATE INDEX `prompt_cases_enabled_idx` ON `prompt_cases` (`enabled`);
CREATE INDEX `prompt_cases_suite_id_idx` ON `prompt_cases` (`suite_id`);
CREATE INDEX `prompt_suites_category_idx` ON `prompt_suites` (`category`(191));
