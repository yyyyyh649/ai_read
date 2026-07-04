"""
PDF 解析模块 — 提取文本、元数据、分段、表格等
"""

import fitz  # PyMuPDF
import re
from pathlib import Path
from typing import Optional


class PaperParser:
    """论文 PDF 解析器"""

    def __init__(self, filepath: str):
        self.filepath = Path(filepath)
        self.doc: Optional[fitz.Document] = None

    def open(self):
        self.doc = fitz.open(str(self.filepath))
        return self

    def close(self):
        if self.doc:
            self.doc.close()

    def __enter__(self):
        return self.open()

    def __exit__(self, *args):
        self.close()

    def get_metadata(self) -> dict:
        """提取 PDF 元数据"""
        meta = self.doc.metadata
        return {
            "title": meta.get("title", ""),
            "author": meta.get("author", ""),
            "subject": meta.get("subject", ""),
            "page_count": len(self.doc),
            "file_size_mb": round(self.filepath.stat().st_size / 1024 / 1024, 2),
        }

    def extract_full_text(self) -> str:
        """提取全文"""
        texts = []
        for page in self.doc:
            text = page.get_text("text")
            if text.strip():
                texts.append(text)
        return "\n\n".join(texts)

    def extract_text_by_pages(self, max_pages: Optional[int] = None) -> list[dict]:
        """按页提取文本，带页码"""
        pages = []
        total = len(self.doc)
        limit = min(total, max_pages) if max_pages else total

        for i in range(limit):
            page = self.doc[i]
            text = page.get_text("text")
            if text.strip():
                pages.append({"page": i + 1, "text": text.strip()})

        return pages

    def extract_sections(self) -> list[dict]:
        """
        尝试识别论文章节（Abstract, Introduction, Methods, Results, Conclusion 等）
        """
        full_text = self.extract_full_text()
        sections = self._segment_by_headers(full_text)
        return sections

    def _segment_by_headers(self, text: str) -> list[dict]:
        """
        通过常见标题模式分割章节
        """
        # 常见论文章节标题
        section_patterns = [
            r'(?:^|\n)\s*(?:Abstract|ABSTRACT)\s*\n',
            r'(?:^|\n)\s*(?:\d+\.?\s*)?(?:Introduction|INTRODUCTION)\s*\n',
            r'(?:^|\n)\s*(?:\d+\.?\s*)?(?:Related\s+Work|RELATED\s+WORK|Background|BACKGROUND)\s*\n',
            r'(?:^|\n)\s*(?:\d+\.?\s*)?(?:Method|METHOD|Methods|METHODS|Methodology|METHODOLOGY|Approach|APPROACH)\s*\n',
            r'(?:^|\n)\s*(?:\d+\.?\s*)?(?:Experiment|EXPERIMENT|Experiments|EXPERIMENTS|Evaluation|EVALUATION)\s*\n',
            r'(?:^|\n)\s*(?:\d+\.?\s*)?(?:Result|RESULT|Results|RESULTS|Finding|FINDINGS)\s*\n',
            r'(?:^|\n)\s*(?:\d+\.?\s*)?(?:Discussion|DISCUSSION|Analysis|ANALYSIS)\s*\n',
            r'(?:^|\n)\s*(?:\d+\.?\s*)?(?:Conclusion|CONCLUSION|Summary|SUMMARY)\s*\n',
            r'(?:^|\n)\s*(?:\d+\.?\s*)?(?:Reference|REFERENCE|References|REFERENCES|Bibliography|BIBLIOGRAPHY)\s*\n',
        ]

        section_names = [
            "Abstract", "Introduction", "Related Work",
            "Methods", "Experiments", "Results",
            "Discussion", "Conclusion", "References"
        ]

        # 简单方法：按双换行分割大段，然后用关键词匹配
        # 更健壮的方法用正则找所有匹配位置
        positions = []
        for pattern, name in zip(section_patterns, section_names):
            for m in re.finditer(pattern, text, re.IGNORECASE):
                positions.append((m.start(), name))

        positions.sort()

        sections = []
        for i, (pos, name) in enumerate(positions):
            start = pos
            end = positions[i + 1][0] if i + 1 < len(positions) else len(text)
            content = text[start:end].strip()
            sections.append({"section": name, "content": content[:8000]})  # 限制长度

        # 如果没识别到章节，返回一个整体
        if not sections:
            sections.append({"section": "Full Text", "content": text[:10000]})

        return sections

    def get_text_snippet(self, max_chars: int = 50000) -> str:
        """获取截断的全文（限制 token 数量）"""
        full = self.extract_full_text()
        return full[:max_chars]
