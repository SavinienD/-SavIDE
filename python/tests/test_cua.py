"""cua : télémétrie de cua-driver coupée pour la commande et pour le démon « serve »."""
import os, stat, sys

import pytest

from axecode_kernel import cua

FAUX = """#!/bin/sh
D=$(dirname "$0")
case "$1" in
 serve) echo "$CUA_DRIVER_RS_TELEMETRY_ENABLED" > "$D/demon"; sleep 3;;
 status) [ -f "$D/demon" ];;
 *) if [ -f "$D/demon" ]; then echo "cmd=$CUA_DRIVER_RS_TELEMETRY_ENABLED demon=$(cat "$D/demon")"; else echo "Cua Driver daemon is not running on x" >&2; exit 1; fi;;
esac
"""


@pytest.mark.skipif(sys.platform == "win32", reason="faux cua-driver en script shell")
def test_telemetrie_coupee(tmp_path, monkeypatch):
    faux = tmp_path / "cua-driver"
    faux.write_text(FAUX)
    faux.chmod(faux.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("CUA_DRIVER_BIN", str(faux))
    monkeypatch.setenv("CUA_DRIVER_RS_TELEMETRY_ENABLED", "1")
    assert cua.run("call", "list_windows", timeout=20).strip() == "cmd=0 demon=0"
    assert os.environ["CUA_DRIVER_RS_TELEMETRY_ENABLED"] == "1"
