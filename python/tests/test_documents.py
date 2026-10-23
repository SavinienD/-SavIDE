import zipfile

import pytest

from axecode_kernel import files


def test_xlsx_is_read_as_text(workspace):
    openpyxl = pytest.importorskip("openpyxl")
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = "Ventes"
    sheet.append(["Produit", "Prix"])
    sheet.append(["Café", 2.5])
    book.create_sheet("Vide")
    book.save(workspace / "data.xlsx")
    text = files.read("data.xlsx")
    assert "## Sheet: Ventes" in text
    assert "Produit\tPrix" in text
    assert "Café\t2.5" in text
    assert "## Sheet: Vide" in text


def test_docx_is_read_as_text(workspace):
    docx = pytest.importorskip("docx")
    document = docx.Document()
    document.add_heading("Rapport", level=1)
    document.add_paragraph("Premier paragraphe.")
    table = document.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "A"
    table.rows[0].cells[1].text = "B"
    document.save(workspace / "doc.docx")
    text = files.read("doc.docx")
    assert "## Rapport" in text
    assert "Premier paragraphe." in text
    assert "A | B" in text


def test_pdf_is_read_as_text(workspace):
    pypdf = pytest.importorskip("pypdf")
    writer = pypdf.PdfWriter()
    writer.add_blank_page(width=200, height=200)
    with open(workspace / "blank.pdf", "wb") as handle:
        writer.write(handle)
    text = files.read("blank.pdf")
    assert "## Page 1" in text
    assert "no extractable text" in text


def test_pptx_text_with_stdlib(workspace):
    slide = (
        '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>'
        "<a:p><a:r><a:t>Titre &amp; sous-titre</a:t></a:r></a:p>"
        "<a:p><a:r><a:t>Deuxième ligne</a:t></a:r></a:p>"
        "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>"
    )
    with zipfile.ZipFile(workspace / "deck.pptx", "w") as archive:
        archive.writestr("ppt/slides/slide2.xml", slide.replace("Titre", "Autre"))
        archive.writestr("ppt/slides/slide1.xml", slide)
    text = files.read("deck.pptx")
    assert text.index("## Slide 1") < text.index("## Slide 2")
    assert "Titre & sous-titre\nDeuxième ligne" in text


def test_epub_text_with_stdlib(workspace):
    with zipfile.ZipFile(workspace / "book.epub", "w") as archive:
        archive.writestr(
            "META-INF/container.xml",
            '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
        )
        archive.writestr(
            "OEBPS/content.opf",
            '<package><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>'
            '</manifest><spine><itemref idref="c1"/></spine></package>',
        )
        archive.writestr("OEBPS/ch1.xhtml", "<html><body><h1>Chapitre</h1><p>Il était une fois</p></body></html>")
    text = files.read("book.epub")
    assert "Chapitre\nIl était une fois" in text


def test_binary_files_raise_instead_of_garbage(workspace):
    (workspace / "blob.bin").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR")
    with pytest.raises(ValueError, match="binary file"):
        files.read("blob.bin")
    (workspace / "old.doc").write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1\x00\x00")
    with pytest.raises(ValueError, match="Word 97-2003"):
        files.read("old.doc")


def test_documents_cannot_be_edited_or_overwritten_as_text(workspace):
    with zipfile.ZipFile(workspace / "deck.pptx", "w") as archive:
        archive.writestr("ppt/slides/slide1.xml", "<a:t>x</a:t>")
    files.read("deck.pptx")
    with pytest.raises(ValueError, match="binary document"):
        files.edit("deck.pptx", [("x", "y")])
    with pytest.raises(ValueError, match="document format"):
        files.write("deck.pptx", "plain text")


def test_utf16_text_is_not_treated_as_binary(workspace):
    (workspace / "u16.txt").write_bytes("bonjour".encode("utf-16"))
    assert files.read("u16.txt")  # decoded, no error
