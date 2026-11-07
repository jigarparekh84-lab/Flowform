"""run leases: attempts, started_at, heartbeat_at, dispatched_at (CR-004)

Revision ID: 0003
Revises: 0002
"""
from alembic import op
import sqlalchemy as sa

revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('runs', sa.Column('attempts', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('runs', sa.Column('started_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('runs', sa.Column('heartbeat_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('runs', sa.Column('dispatched_at', sa.DateTime(timezone=True), nullable=True))
    # The reaper's two scans: stale `running` rows and lost `queued` dispatches.
    op.create_index('ix_runs_status_heartbeat_at', 'runs', ['status', 'heartbeat_at'])
    op.create_index('ix_runs_status_dispatched_at', 'runs', ['status', 'dispatched_at'])


def downgrade() -> None:
    op.drop_index('ix_runs_status_dispatched_at', table_name='runs')
    op.drop_index('ix_runs_status_heartbeat_at', table_name='runs')
    op.drop_column('runs', 'dispatched_at')
    op.drop_column('runs', 'heartbeat_at')
    op.drop_column('runs', 'started_at')
    op.drop_column('runs', 'attempts')
