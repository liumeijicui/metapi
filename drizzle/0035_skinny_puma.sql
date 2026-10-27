ALTER TABLE `admin_login_logs` ADD `peer_ip` text;--> statement-breakpoint
ALTER TABLE `admin_login_logs` ADD `ip_chain` text;--> statement-breakpoint
ALTER TABLE `admin_login_logs` ADD `fingerprint` text;--> statement-breakpoint
ALTER TABLE `admin_login_logs` ADD `fingerprint_detail` text;--> statement-breakpoint
ALTER TABLE `admin_login_logs` ADD `spoof_suspect` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `admin_login_logs_fingerprint_created_at_idx` ON `admin_login_logs` (`fingerprint`,`created_at`);