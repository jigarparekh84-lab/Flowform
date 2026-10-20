"""Alias of `flowform_engine.multi_period` (moved in FF-103); keeps `app.multi_period` imports working."""

import sys

from flowform_engine import multi_period as _impl

sys.modules[__name__] = _impl
