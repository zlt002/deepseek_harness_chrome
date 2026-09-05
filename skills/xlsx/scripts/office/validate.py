# Source-tree compatibility entry; distributions receive the shared original.
from pathlib import Path as _Path
import sys as _sys

_office_root = _Path(__file__).resolve().parents[3] / "_shared" / "office"
__file__ = str(_office_root / "validate.py")
_sys.path.insert(0, str(_office_root))
exec(compile(_Path(__file__).read_bytes(), __file__, "exec"), globals())
