-- The singleton reads as revision 0; the shared model editor rereads it before its next save.
ALTER TABLE `global_agent_configuration` ADD COLUMN `revision` integer NOT NULL DEFAULT 0;
