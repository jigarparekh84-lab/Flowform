"""tenancy core: tenants, users, projects, project_versions, scenarios, runs,
audit_events + PostGIS + tenant RLS (FF-104)

Revision ID: 0001
Revises:
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

APP_ROLE = "flowform_app"
TENANT_TABLES = ("users", "projects", "project_versions", "scenarios", "runs", "audit_events")
ALL_TABLES = ("audit_events", "runs", "scenarios", "project_versions", "projects", "users", "tenants")
RLS_EXPR = "tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid"


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    op.create_table('tenants',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('external_id', sa.String(length=200), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('external_id')
    )
    op.create_table('audit_events',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('tenant_id', sa.UUID(), nullable=False),
    sa.Column('actor_id', sa.UUID(), nullable=True),
    sa.Column('action', sa.String(length=80), nullable=False),
    sa.Column('target', sa.String(length=200), nullable=True),
    sa.Column('detail', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_audit_events_tenant_id'), 'audit_events', ['tenant_id'], unique=False)
    op.create_table('users',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('tenant_id', sa.UUID(), nullable=False),
    sa.Column('email', sa.String(length=320), nullable=False),
    sa.Column('role', sa.String(length=20), nullable=False),
    sa.Column('external_id', sa.String(length=200), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('tenant_id', 'email')
    )
    op.create_index(op.f('ix_users_tenant_id'), 'users', ['tenant_id'], unique=False)
    op.create_table('projects',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('tenant_id', sa.UUID(), nullable=False),
    sa.Column('name', sa.String(length=300), nullable=False),
    sa.Column('current_version', sa.Integer(), nullable=False),
    sa.Column('created_by', sa.UUID(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_projects_tenant_id'), 'projects', ['tenant_id'], unique=False)
    op.create_table('project_versions',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('tenant_id', sa.UUID(), nullable=False),
    sa.Column('project_id', sa.UUID(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('snapshot_raw', sa.Text(), nullable=False),
    sa.Column('created_by', sa.UUID(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('project_id', 'version')
    )
    op.create_index(op.f('ix_project_versions_project_id'), 'project_versions', ['project_id'], unique=False)
    op.create_index(op.f('ix_project_versions_tenant_id'), 'project_versions', ['tenant_id'], unique=False)
    op.create_table('scenarios',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('tenant_id', sa.UUID(), nullable=False),
    sa.Column('project_id', sa.UUID(), nullable=False),
    sa.Column('name', sa.String(length=300), nullable=False),
    sa.Column('spec', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_scenarios_project_id'), 'scenarios', ['project_id'], unique=False)
    op.create_index(op.f('ix_scenarios_tenant_id'), 'scenarios', ['tenant_id'], unique=False)
    op.create_table('runs',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('tenant_id', sa.UUID(), nullable=False),
    sa.Column('project_id', sa.UUID(), nullable=False),
    sa.Column('scenario_id', sa.UUID(), nullable=True),
    sa.Column('kind', sa.String(length=30), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('input_hash', sa.String(length=64), nullable=True),
    sa.Column('engine_version', sa.String(length=40), nullable=True),
    sa.Column('solver_version', sa.String(length=80), nullable=True),
    sa.Column('result', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['scenario_id'], ['scenarios.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_runs_project_id'), 'runs', ['project_id'], unique=False)
    op.create_index(op.f('ix_runs_tenant_id'), 'runs', ['tenant_id'], unique=False)

    # Non-owner runtime role; RLS is FORCEd so even the table owner obeys it
    # (superusers still bypass — the app never connects as one in production).
    op.execute(
        f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{APP_ROLE}') "
        f"THEN CREATE ROLE {APP_ROLE} NOLOGIN; END IF; END $$"
    )
    op.execute(f"GRANT {APP_ROLE} TO CURRENT_USER")
    op.execute(f"GRANT USAGE ON SCHEMA public TO {APP_ROLE}")
    op.execute(f"GRANT SELECT ON tenants TO {APP_ROLE}")
    op.execute("ALTER TABLE tenants ENABLE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY tenant_self ON tenants FOR SELECT TO {APP_ROLE} "
        "USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)"
    )
    for t in TENANT_TABLES:
        op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {t} TO {APP_ROLE}")
        op.execute(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {t} FORCE ROW LEVEL SECURITY")
        op.execute(f"CREATE POLICY tenant_isolation ON {t} USING ({RLS_EXPR}) WITH CHECK ({RLS_EXPR})")


def downgrade() -> None:
    for t in ALL_TABLES:
        op.drop_table(t)
