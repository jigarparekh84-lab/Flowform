"""Alias of `flowform_engine.solver` (moved in FF-103); keeps `app.solver` imports working."""

import sys

from flowform_engine import solver as _impl

sys.modules[__name__] = _impl
