CREATE TABLE `event` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`node_path` text,
	`attempt` integer,
	`kind` text NOT NULL,
	`stream` text,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_run_node_attempt_seq_idx` ON `event` (`run_id`,`node_path`,`attempt`,`seq`);--> statement-breakpoint
CREATE TABLE `run` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	`recording_status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_workspace_started_idx` ON `run` (`workspace_id`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `run_project_started_idx` ON `run` (`project_id`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `run_workspace_workflow_started_idx` ON `run` (`workspace_id`,`workflow_id`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `run_workspace_status_started_idx` ON `run` (`workspace_id`,`status`,`started_at`,`id`);--> statement-breakpoint
CREATE TABLE `step` (
	`run_id` text NOT NULL,
	`node_path` text NOT NULL,
	`attempt` integer NOT NULL,
	`node_kind` text NOT NULL,
	`user_id` text,
	`status` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`duration_ms` integer,
	`exit_code` integer,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `node_path`, `attempt`),
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`root_dir` text NOT NULL,
	`rigg_dir` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_root_dir_unique` ON `workspace` (`root_dir`);--> statement-breakpoint
CREATE INDEX `workspace_project_idx` ON `workspace` (`project_id`);