"""Alias of `flowform_engine.diagnostics` (moved in FF-103); keeps `app.diagnostics` imports working."""

import sys

from flowform_engine import diagnostics as _impl

sys.modules[__name__] = _impl
