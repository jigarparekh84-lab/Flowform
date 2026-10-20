"""Alias of `flowform_engine.explain` (moved in FF-103); keeps `app.explain` imports working."""

import sys

from flowform_engine import explain as _impl

sys.modules[__name__] = _impl
