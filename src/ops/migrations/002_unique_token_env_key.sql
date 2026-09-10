CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_clients_token_env_key_unique
  ON ops_clients (token_env_key);
