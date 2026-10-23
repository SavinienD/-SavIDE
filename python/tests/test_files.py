import pytest

from axecode_kernel import files


def test_write_read_roundtrip(workspace):
    assert "created" in files.write("a/b.txt", "hello\nworld\n")
    assert files.read("a/b.txt") == "hello\nworld\n"
    assert files.read("a/b.txt", offset=1, limit=1) == "world\n"
    assert files.read("a/b.txt", numbered=True).startswith("1 | hello")


def test_overwrite_requires_read(workspace):
    (workspace / "x.txt").write_text("orig", encoding="utf-8")
    with pytest.raises(PermissionError):
        files.write("x.txt", "new")
    files.read("x.txt")
    files.write("x.txt", "new")
    assert (workspace / "x.txt").read_text(encoding="utf-8") == "new"


def test_refuses_stale_file(workspace):
    files.write("s.txt", "v1")
    (workspace / "s.txt").write_text("changed outside", encoding="utf-8")
    with pytest.raises(PermissionError):
        files.edit("s.txt", [("changed", "x")])
    files.read("s.txt")
    files.edit("s.txt", [("changed", "x")])
    assert (workspace / "s.txt").read_text(encoding="utf-8") == "x outside"


def test_edit_ordered_and_atomic(workspace):
    files.write("e.py", "a = 1\nb = 2\nc = 3\n")
    files.edit("e.py", [("a = 1", "a = 10"), {"old": "a = 10\nb", "new": "a = 11\nbb"}])
    assert files.read("e.py") == "a = 11\nbb = 2\nc = 3\n"
    with pytest.raises(ValueError):
        files.edit("e.py", [("c = 3", "c = 4"), ("missing", "x")])
    assert files.read("e.py") == "a = 11\nbb = 2\nc = 3\n"


def test_edit_rejects_ambiguous_match(workspace):
    files.write("d.txt", "x x x")
    with pytest.raises(ValueError):
        files.edit("d.txt", [("x", "y")])
    files.edit("d.txt", [{"old": "x", "new": "y", "all": True}])
    assert files.read("d.txt") == "y y y"


def test_edit_preserves_crlf(workspace):
    (workspace / "w.txt").write_bytes(b"one\r\ntwo\r\n")
    files.read("w.txt")
    files.edit("w.txt", [("one\ntwo", "uno\ndos")])
    assert (workspace / "w.txt").read_bytes() == b"uno\r\ndos\r\n"


def test_glob_and_grep(workspace):
    files.write("src/m.py", "def foo():\n    return 42\n")
    files.write("src/n.txt", "foo bar\n")
    files.write("node_modules/skip.py", "foo\n")
    assert files.glob("*.py") == ["src/m.py"]
    assert files.glob("src/*.txt") == ["src/n.txt"]
    hits = files.grep("foo", glob="*.py")
    assert [(h["path"], h["line"]) for h in hits] == [("src/m.py", 1)]
    assert {h["path"] for h in files.grep("FOO", ignore_case=True)} == {"src/m.py", "src/n.txt"}


def test_delete_and_move(workspace):
    files.write("m.txt", "1")
    files.move("m.txt", "sub/n.txt")
    assert files.exists("sub/n.txt") and not files.exists("m.txt")
    files.write("sub/n.txt", "2")  # fingerprint followed the move
    files.delete("sub/n.txt")
    assert not files.exists("sub/n.txt")
