"""spatial columns, append-only audit trail and time indexes

Revision ID: b2c7f1a90d31
Revises: f8fe3a0842de
Created: 2026-09-16
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "b2c7f1a90d31"
down_revision = "f8fe3a0842de"
branch_labels = None
depends_on = None

# Refuse edits to the audit trail in the database itself, not only in the application.
APPEND_ONLY = """
CREATE OR REPLACE FUNCTION oceanspill_audit_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
"""


def _postgis_available(conn) -> bool:
    return bool(conn.execute(sa.text(
        "SELECT 1 FROM pg_available_extensions WHERE name = 'postgis'")).scalar())


def upgrade() -> None:
    conn = op.get_bind()
    if conn.dialect.name != "postgresql":
        return

    conn.execute(sa.text(APPEND_ONLY))
    conn.execute(sa.text("DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log"))
    conn.execute(sa.text("""
        CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
        FOR EACH ROW EXECUTE FUNCTION oceanspill_audit_append_only()
    """))

    # AIS is by far the largest table and is always queried by time; BRIN suits its append order.
    conn.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_ais_positions_t_brin ON ais_positions USING brin (t)"))

    if not _postgis_available(conn):
        return
    conn.execute(sa.text("CREATE EXTENSION IF NOT EXISTS postgis"))
    # Generated columns, so positions stay in plain latitude and longitude for the application.
    conn.execute(sa.text("""
        ALTER TABLE ais_positions ADD COLUMN IF NOT EXISTS geom geography(Point, 4326)
        GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography) STORED
    """))
    conn.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_ais_positions_geom ON ais_positions USING gist (geom)"))
    conn.execute(sa.text("""
        ALTER TABLE detections ADD COLUMN IF NOT EXISTS geom geography(Point, 4326)
        GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography) STORED
    """))
    conn.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_detections_geom ON detections USING gist (geom)"))


def downgrade() -> None:
    conn = op.get_bind()
    if conn.dialect.name != "postgresql":
        return
    conn.execute(sa.text("DROP INDEX IF EXISTS ix_detections_geom"))
    conn.execute(sa.text("ALTER TABLE detections DROP COLUMN IF EXISTS geom"))
    conn.execute(sa.text("DROP INDEX IF EXISTS ix_ais_positions_geom"))
    conn.execute(sa.text("ALTER TABLE ais_positions DROP COLUMN IF EXISTS geom"))
    conn.execute(sa.text("DROP INDEX IF EXISTS ix_ais_positions_t_brin"))
    conn.execute(sa.text("DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log"))
    conn.execute(sa.text("DROP FUNCTION IF EXISTS oceanspill_audit_append_only()"))
