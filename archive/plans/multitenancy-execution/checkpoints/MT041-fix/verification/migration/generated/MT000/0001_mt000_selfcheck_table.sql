-- multitenancy migrate-test
CREATE TABLE mt_tool_selfcheck (id integer PRIMARY KEY, note text NOT NULL);
--> statement-breakpoint
INSERT INTO mt_tool_selfcheck (id, note) VALUES (1, 'multitenancy migrate-test self-check');
