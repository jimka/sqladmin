#!/usr/bin/env python3
"""
Regenerate the two marker-delimited dependency-inventory tables in
`THIRD-PARTY-NOTICES.md` — the frontend's production npm tree and the
backend's main-group Python tree. Hand-written prose outside the
`<!-- BEGIN/END GENERATED: ... -->` markers, including the bundled-component
notices, is never touched.

Run by hand before tagging a release (see
`plans/implemented/publish-v0-1-0.md`); CI does not check it.

Usage: python3 scripts/generate_third_party_notices.py
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_NOTICES_PATH = _REPO_ROOT / "THIRD-PARTY-NOTICES.md"

# Reads each installed distribution's metadata for a license value, preferring
# the PEP 639 ``License-Expression`` header, then ``Classifier: License :: ...``
# headers, then the first line of the freeform ``License`` header, in that order.
_LICENSE_DUMP = """
from importlib.metadata import metadata, version
import sys, json
out = {}
for n in sys.argv[1:]:
    m = metadata(n)
    e = m.get("License-Expression")
    cls = [c.split("::")[-1].strip() for c in (m.get_all("Classifier") or [])
           if c.startswith("License ::")]
    lic = (m.get("License") or "").strip()
    out[n] = e or "; ".join(cls) or (lic.splitlines()[0] if lic else "UNKNOWN")
print(json.dumps({n: [version(n), out[n]] for n in out}))
"""


def _npm_packages() -> list[tuple[str, str, str]]:
    """
    The frontend's production dependency tree — (name, version, license) —
    via ``npm query``, excluding the root project itself.
    """
    result = subprocess.run(
        ["npm", "query", ":not(.dev)"],
        cwd=_REPO_ROOT / "frontend",
        capture_output=True,
        text=True,
        check=True,
    )
    entries = json.loads(result.stdout)

    return sorted(
        (entry["name"], entry["version"], entry.get("license") or "UNKNOWN")
        for entry in entries
        if entry.get("name") and entry["name"] != "sqladmin-frontend"
    )


def _python_packages() -> list[tuple[str, str, str]]:
    """
    The backend's main-group dependency tree — (name, version, license) — via
    ``poetry show`` for the name list and ``importlib.metadata`` (run inside
    the backend's own virtualenv) for each package's license.
    """
    show = subprocess.run(
        ["poetry", "-C", "backend", "show", "--only", "main", "--no-ansi"],
        capture_output=True,
        text=True,
        check=True,
    )
    names = [line.split()[0] for line in show.stdout.splitlines() if line.strip()]

    dump = subprocess.run(
        ["poetry", "-C", "backend", "run", "python", "-c", _LICENSE_DUMP, *names],
        capture_output=True,
        text=True,
        check=True,
    )
    info: dict[str, list[str]] = json.loads(dump.stdout)

    return sorted((name, version, license_) for name, (version, license_) in info.items())


def _table(rows: list[tuple[str, str, str]]) -> str:
    lines = ["| Package | Version | License |", "|---|---|---|"]
    lines += [f"| {name} | {version} | {license_} |" for name, version, license_ in rows]

    return "\n".join(lines)


def _replace_block(text: str, marker: str, body: str) -> str:
    """Replace the lines strictly between a marker pair, leaving the markers in place."""
    begin, end = f"<!-- BEGIN GENERATED: {marker} -->", f"<!-- END GENERATED: {marker} -->"
    pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end), re.DOTALL)

    if not pattern.search(text):
        raise SystemExit(f"Markers for {marker!r} not found in {_NOTICES_PATH}")

    return pattern.sub(f"{begin}\n{body}\n{end}", text)


def main() -> None:
    npm_rows = _npm_packages()
    python_rows = _python_packages()

    unknown = [
        f"{name} ({source})"
        for source, rows in (("npm", npm_rows), ("python", python_rows))
        for name, _, license_ in rows
        if license_ == "UNKNOWN"
    ]
    if unknown:
        raise SystemExit(f"Unresolved license(s): {', '.join(unknown)}")

    text = _NOTICES_PATH.read_text()
    text = _replace_block(text, "npm", _table(npm_rows))
    text = _replace_block(text, "python", _table(python_rows))
    _NOTICES_PATH.write_text(text)

    print(f"Wrote {len(npm_rows)} npm and {len(python_rows)} python entries to {_NOTICES_PATH}")


if __name__ == "__main__":
    main()
