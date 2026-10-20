"""Alias of `flowform_engine.multi_period_run` (moved in FF-103); keeps `app.multi_period_run` imports working."""

import sys

from flowform_engine import multi_period_run as _impl

sys.modules[__name__] = _impl
