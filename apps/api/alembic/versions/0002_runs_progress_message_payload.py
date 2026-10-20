"""runs progress message payload

Revision ID: 0002
Revises: 0001
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('runs', sa.Column('progress', sa.Float(), nullable=False, server_default='0'))
    op.add_column('runs', sa.Column('message', sa.Text(), nullable=True))
    op.add_column('runs', sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=True))


def downgrade() -> None:
    op.drop_column('runs', 'payload')
    op.drop_column('runs', 'message')
    op.drop_column('runs', 'progress')
