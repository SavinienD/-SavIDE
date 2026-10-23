import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture()
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("AXECODE_WORKSPACE", str(tmp_path))
    from axecode_kernel import files

    files._fingerprints.clear()
    return tmp_path
