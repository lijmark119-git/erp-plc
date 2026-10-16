ALTER TABLE users ADD COLUMN username VARCHAR(64);

DO $$
DECLARE
  account RECORD;
  base_username TEXT;
  candidate_username TEXT;
  suffix INTEGER;
BEGIN
  FOR account IN
    SELECT id, organization_id, email
    FROM users
    ORDER BY organization_id, email, id
  LOOP
    base_username := lower(regexp_replace(split_part(account.email, '@', 1), '[^a-z0-9._-]', '', 'g'));
    base_username := trim(both '._-' from left(base_username, 64));
    IF base_username = '' THEN
      base_username := 'user';
    END IF;

    candidate_username := base_username;
    suffix := 2;
    WHILE EXISTS (
      SELECT 1
      FROM users
      WHERE organization_id = account.organization_id
        AND username = candidate_username
    ) LOOP
      candidate_username := left(base_username, 64 - length('-' || suffix::TEXT)) || '-' || suffix::TEXT;
      suffix := suffix + 1;
    END LOOP;

    UPDATE users
    SET username = candidate_username
    WHERE id = account.id;
  END LOOP;
END $$;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_organization_id_email_key;
ALTER TABLE users ADD CONSTRAINT users_organization_id_username_key UNIQUE (organization_id, username);
ALTER TABLE users DROP COLUMN email;
