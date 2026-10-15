CREATE TABLE `geotwin_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(254) NOT NULL,
	`name` varchar(100) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`terms_version` varchar(32) NOT NULL,
	`terms_accepted_at` timestamp NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`last_signed_in` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geotwin_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `geotwin_accounts_email_uq` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `geotwin_sessions` (
	`token_hash` varchar(64) NOT NULL,
	`account_id` int NOT NULL,
	`expires_at` timestamp NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geotwin_sessions_token_hash` PRIMARY KEY(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `geotwin_sessions` ADD CONSTRAINT `geotwin_sessions_account_id_geotwin_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `geotwin_accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `geotwin_accounts_created_idx` ON `geotwin_accounts` (`created_at`);--> statement-breakpoint
CREATE INDEX `geotwin_sessions_account_idx` ON `geotwin_sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `geotwin_sessions_expires_idx` ON `geotwin_sessions` (`expires_at`);