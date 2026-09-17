"""Alembic environment: the database URL and the table definitions both come from the application."""
from __future__ import annotations

from alembic import context
from sqlalchemy import pool

from oceanspill.api.db import Base, make_engine
from oceanspill.api.settings import ApiSettings
import oceanspill.api.models  # noqa: F401  (registers every table on Base)

config = context.config
target_metadata = Base.metadata

# PostGIS owns these, and the spatial columns and hand-written indexes are added by a migration
# rather than by the table definitions. Autogenerate must not offer to drop them.
POSTGIS_TABLES = {"spatial_ref_sys", "geography_columns", "geometry_columns", "raster_columns", "raster_overviews"}
MANAGED_BY_MIGRATION = {"geom", "ix_ais_positions_geom", "ix_detections_geom", "ix_ais_positions_t_brin"}


def include_object(obj, name, type_, reflected, compare_to) -> bool:
    if type_ == "table" and name in POSTGIS_TABLES:
        return False
    return not (reflected and name in MANAGED_BY_MIGRATION)


def database_url() -> str:
    return config.get_main_option("sqlalchemy.url") or ApiSettings.load().database_url


def run_migrations_offline() -> None:
    context.configure(url=database_url(), target_metadata=target_metadata, literal_binds=True,
                      dialect_opts={"paramstyle": "named"}, compare_type=True, include_object=include_object)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = make_engine(database_url())
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True,
                          include_object=include_object,
                          render_as_batch=connection.dialect.name == "sqlite")
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
