"""Replace user email identifiers with usernames.

Revision ID: 20261014_02_usernames
Revises: 20261013_01_auth_access
Create Date: 2026-10-14 01:00:00.000000
"""

import re

from alembic import op
import sqlalchemy as sa


revision = "20261014_02_usernames"
down_revision = "20261013_01_auth_access"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("username", sa.String(length=64), nullable=True))
    connection = op.get_bind()
    users = sa.table(
        "users",
        sa.column("id", sa.String(length=36)),
        sa.column("email", sa.String(length=255)),
        sa.column("username", sa.String(length=64)),
    )
    used_usernames: set[str] = set()
    rows = connection.execute(
        sa.select(users.c.id, users.c.email).order_by(users.c.id)
    ).mappings()
    for row in rows:
        email_local_part = str(row["email"]).split("@", 1)[0].strip().lower()
        base = re.sub(r"[^a-z0-9._-]", "", email_local_part).strip("._-")[:64] or "user"
        username = base
        suffix = 2
        while username in used_usernames:
            suffix_text = f"-{suffix}"
            username = f"{base[:64 - len(suffix_text)]}{suffix_text}"
            suffix += 1
        connection.execute(
            users.update().where(users.c.id == row["id"]).values(username=username)
        )
        used_usernames.add(username)

    op.alter_column("users", "username", nullable=False)
    op.create_unique_constraint("uq_users_username", "users", ["username"])
    op.drop_constraint("uq_users_email", "users", type_="unique")
    op.drop_column("users", "email")


def downgrade() -> None:
    raise RuntimeError("The username migration cannot restore the original email addresses.")
