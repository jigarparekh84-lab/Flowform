from __future__ import annotations

from alembic import context
from sqlalchemy import create_engine

from app.db.models import Base
from app.db.session import database_url

target_metadata = Base.metadata
OWN_TABLES = set(Base.metadata.tables)


def include_object(obj, name, type_, reflected, compare_to):
    # PostGIS images ship tiger/topology tables; only diff our own tables.
    if type_ == "table":
        return name in OWN_TABLES
    return True


def run() -> None:
    url = context.config.get_main_option("sqlalchemy.url") or database_url()
    if context.is_offline_mode():
        context.configure(url=url, target_metadata=target_metadata, literal_binds=True)
        with context.begin_transaction():
            context.run_migrations()
        return
    with create_engine(url).connect() as conn:
        context.configure(connection=conn, target_metadata=target_metadata, include_object=include_object)
        with context.begin_transaction():
            context.run_migrations()


run()
