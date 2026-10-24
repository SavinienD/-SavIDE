import base64
import json

from axecode_kernel import bridge, images

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
)


def test_read_and_show_attach_png_with_media_type(workspace):
    (workspace / "p.png").write_bytes(PNG)
    bridge.take_attachments()
    images.read("p.png")
    images.show(PNG)
    attached, _ = bridge.take_attachments()
    assert len(attached) == 2
    for image in attached:
        # The host deserialises ToolResultImage: ``media_type`` is required.
        assert image["media_type"] == "image/png"
        assert base64.b64decode(image["data"]) == PNG
    assert attached[0]["path"] == "p.png"
    json.dumps(attached)
