ALTER TABLE user_credentials ADD COLUMN production_dms_url text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE user_credentials ADD COLUMN production_dms_authorization text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE user_credentials ADD COLUMN production_sls_access_key_id text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE user_credentials ADD COLUMN production_sls_access_key_secret text NOT NULL DEFAULT '';
