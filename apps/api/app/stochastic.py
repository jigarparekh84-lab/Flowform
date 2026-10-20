"""Alias of `flowform_engine.stochastic` (moved in FF-103); keeps `app.stochastic` imports working."""

import sys

from flowform_engine import stochastic as _impl

sys.modules[__name__] = _impl
