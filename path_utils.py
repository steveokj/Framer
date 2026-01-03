"""
Shared helpers for working with filesystem paths across the project.
"""

from __future__ import annotations

from pathlib import Path


def canonicalize_path(value: str | Path) -> str:
    """
    Returns a normalized, lowercase path string suitable for database keys.
    Paths are resolved (without requiring existence), forward-slash separated,
    and lowercased to guarantee stable comparisons across platforms.
    """
    path = Path(value).expanduser()
    try:
        resolved = path.resolve(strict=False)
    except Exception:
        resolved = path.absolute()
    return str(resolved).replace("\\", "/").lower()


__all__ = ["canonicalize_path"]

