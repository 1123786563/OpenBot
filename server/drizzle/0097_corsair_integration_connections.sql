CREATE TABLE IF NOT EXISTS corsair_integration_connections (
  workspace_id text NOT NULL,
  integration_id text NOT NULL,
  person_id text NOT NULL,
  connected_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT corsair_integration_connections_pk PRIMARY KEY (workspace_id, integration_id)
);
