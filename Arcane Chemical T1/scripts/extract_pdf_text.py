from __future__ import annotations

from pathlib import Path

from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "data" / "source_docs"
OUT_DIR = ROOT / "data" / "cache" / "extracted_text"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for pdf_path in sorted(SOURCE_DIR.glob("*.pdf")):
        reader = PdfReader(str(pdf_path))
        text = "\n".join((page.extract_text() or "") for page in reader.pages)
        out_path = OUT_DIR / f"{pdf_path.stem}.txt"
        out_path.write_text(text, encoding="utf-8")
        print(f"Extracted {pdf_path.name} -> {out_path.name}")


if __name__ == "__main__":
    main()

