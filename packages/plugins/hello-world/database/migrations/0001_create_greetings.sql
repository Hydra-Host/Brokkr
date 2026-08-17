CREATE TABLE plugin_hello_world.greetings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO plugin_hello_world.greetings (message) VALUES
  ('hello from the hello-world plugin'),
  ('this row was inserted by a plugin-owned migration');
