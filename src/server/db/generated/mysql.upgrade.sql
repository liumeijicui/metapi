CREATE TABLE IF NOT EXISTS `trusted_fingerprints` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `fingerprint` TEXT NOT NULL, `label` TEXT, `note` TEXT, `last_ip` TEXT, `last_user_agent` TEXT, `last_seen_at` VARCHAR(191), `created_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')), `updated_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')));
CREATE UNIQUE INDEX `trusted_fingerprints_fingerprint_unique` ON `trusted_fingerprints` (`fingerprint`(191));
CREATE INDEX `trusted_fingerprints_created_at_idx` ON `trusted_fingerprints` (`created_at`);
