CREATE TABLE `geotwin_analyses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`analysis_type` varchar(80) NOT NULL,
	`region` varchar(64),
	`parameters` longtext NOT NULL,
	`result` longtext NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geotwin_analyses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `geotwin_chat_messages` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`conversation_id` varchar(80) NOT NULL,
	`role` enum('user','assistant') NOT NULL,
	`content` longtext NOT NULL,
	`context` longtext,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geotwin_chat_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `geotwin_datasets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`dataset_key` varchar(160) NOT NULL,
	`display_name` varchar(255) NOT NULL,
	`category` varchar(64) NOT NULL,
	`source_file` varchar(255) NOT NULL,
	`source_type` enum('seed','upload') NOT NULL,
	`status` enum('ready','processing','error') NOT NULL DEFAULT 'processing',
	`active` int NOT NULL DEFAULT 1,
	`total_records` int NOT NULL DEFAULT 0,
	`mapped_records` int NOT NULL DEFAULT 0,
	`invalid_coordinates` int NOT NULL DEFAULT 0,
	`metadata` longtext,
	`source_hash` varchar(64),
	`imported_at` timestamp NOT NULL DEFAULT (now()),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geotwin_datasets_id` PRIMARY KEY(`id`),
	CONSTRAINT `geotwin_datasets_key_uq` UNIQUE(`dataset_key`)
);
--> statement-breakpoint
CREATE TABLE `geotwin_features` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`dataset_id` int NOT NULL,
	`category` varchar(64) NOT NULL,
	`region` varchar(64),
	`feature_hash` varchar(64) NOT NULL,
	`name` varchar(255),
	`latitude` double,
	`longitude` double,
	`geometry_type` varchar(32),
	`geometry` longtext,
	`properties` longtext NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geotwin_features_id` PRIMARY KEY(`id`),
	CONSTRAINT `geotwin_features_dataset_hash_uq` UNIQUE(`dataset_id`,`feature_hash`)
);
--> statement-breakpoint
CREATE TABLE `geotwin_imports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`dataset_id` int,
	`source_file` varchar(255) NOT NULL,
	`category` varchar(64) NOT NULL,
	`status` enum('previewed','processing','succeeded','failed') NOT NULL,
	`records_read` int NOT NULL DEFAULT 0,
	`records_imported` int NOT NULL DEFAULT 0,
	`invalid_coordinates` int NOT NULL DEFAULT 0,
	`duplicate_records` int NOT NULL DEFAULT 0,
	`details` longtext,
	`started_at` timestamp NOT NULL DEFAULT (now()),
	`completed_at` timestamp,
	CONSTRAINT `geotwin_imports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `geotwin_metrics` (
	`id` int AUTO_INCREMENT NOT NULL,
	`metric_key` varchar(190) NOT NULL,
	`source_file` varchar(255) NOT NULL,
	`payload` longtext NOT NULL,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `geotwin_metrics_id` PRIMARY KEY(`id`),
	CONSTRAINT `geotwin_metrics_key_uq` UNIQUE(`metric_key`)
);
--> statement-breakpoint
ALTER TABLE `geotwin_features` ADD CONSTRAINT `geotwin_features_dataset_id_geotwin_datasets_id_fk` FOREIGN KEY (`dataset_id`) REFERENCES `geotwin_datasets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geotwin_imports` ADD CONSTRAINT `geotwin_imports_dataset_id_geotwin_datasets_id_fk` FOREIGN KEY (`dataset_id`) REFERENCES `geotwin_datasets`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `geotwin_analyses_created_idx` ON `geotwin_analyses` (`created_at`);--> statement-breakpoint
CREATE INDEX `geotwin_chat_conversation_idx` ON `geotwin_chat_messages` (`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `geotwin_datasets_category_idx` ON `geotwin_datasets` (`category`,`active`);--> statement-breakpoint
CREATE INDEX `geotwin_features_category_region_idx` ON `geotwin_features` (`category`,`region`);--> statement-breakpoint
CREATE INDEX `geotwin_features_dataset_category_idx` ON `geotwin_features` (`dataset_id`,`category`);--> statement-breakpoint
CREATE INDEX `geotwin_features_lat_lon_idx` ON `geotwin_features` (`latitude`,`longitude`);--> statement-breakpoint
CREATE INDEX `geotwin_imports_started_idx` ON `geotwin_imports` (`started_at`);