"""
AI Paper Reader — FastAPI 后端
论文 AI 阅读助手：速览、总结、思维导图、实验汇总、划词翻译、全文翻译
"""

import os
import uuid
import shutil
import json
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from typing import Optional, List, Dict, Any

from dotenv import load_dotenv
load_dotenv(dotenv_path="../.env")

from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from pdf_parser import PaperParser
from ai_service import ai_service

from pydantic import BaseModel, Field

class ConfigUpdate(BaseModel):
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None
    fast_base_url: Optional[str] = None
    fast_api_key: Optional[str] = None
    fast_model: Optional[str] = None

class ModelFetchRequest(BaseModel):
    base_url: str
    api_key: str

# ─── 配置 ───
UPLOAD_DIR = Path(__file__).parent.parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
DATA_DIR = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "papers.db"
MAX_UPLOAD_SIZE = int(os.getenv("MAX_UPLOAD_SIZE_MB", "50")) * 1024 * 1024

# 全局存储：{file_id: {"path": str, "text": str, "meta": dict, "sections": list, "pages": list}}
paper_store: dict = {}


def _init_db():
    """初始化 SQLite 数据库，持久化论文元数据和 AI 分析结果"""
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS papers (
            file_id TEXT PRIMARY KEY,
            filename TEXT,
            title TEXT,
            page_count INTEGER,
            text_length INTEGER,
            text TEXT,
            meta TEXT,
            sections TEXT,
            pages TEXT,
            upload_time TEXT
        )
    ''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id TEXT,
            tab TEXT,
            result_text TEXT,
            created_time TEXT,
            FOREIGN KEY (file_id) REFERENCES papers (file_id)
        )
    ''')
    c.execute('''
        CREATE INDEX IF NOT EXISTS idx_results_file_tab ON results (file_id, tab)
    ''')
    conn.commit()
    conn.close()


def _load_papers_from_db():
    """启动时从数据库恢复论文到内存"""
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute("SELECT * FROM papers ORDER BY upload_time DESC")
    rows = c.fetchall()
    conn.close()

    for row in rows:
        file_id = row[0]
        filepath = UPLOAD_DIR / f"{file_id}.pdf"
        if not filepath.exists():
            continue
        try:
            paper_store[file_id] = {
                "path": str(filepath),
                "text": row[5] or "",
                "meta": json.loads(row[6] or "{}"),
                "sections": json.loads(row[7] or "[]"),
                "pages": json.loads(row[8] or "[]"),
            }
        except json.JSONDecodeError:
            continue


def _save_paper_to_db(file_id: str, filename: str, store: dict):
    """保存论文到数据库"""
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    meta = store.get("meta", {})
    c.execute('''
        INSERT OR REPLACE INTO papers
        (file_id, filename, title, page_count, text_length, text, meta, sections, pages, upload_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        file_id,
        filename,
        meta.get("title", ""),
        meta.get("page_count", 0),
        len(store.get("text", "")),
        store.get("text", ""),
        json.dumps(meta, ensure_ascii=False),
        json.dumps(store.get("sections", []), ensure_ascii=False),
        json.dumps(store.get("pages", []), ensure_ascii=False),
        datetime.now(timezone.utc).isoformat(),
    ))
    conn.commit()
    conn.close()


def _save_result_to_db(file_id: str, tab: str, result_text: str):
    """保存某个论文的某个 tab 分析结果"""
    if not result_text:
        return
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    # 先删除旧结果，只保留最新
    c.execute("DELETE FROM results WHERE file_id = ? AND tab = ?", (file_id, tab))
    c.execute('''
        INSERT INTO results (file_id, tab, result_text, created_time)
        VALUES (?, ?, ?, ?)
    ''', (
        file_id,
        tab,
        result_text,
        datetime.now(timezone.utc).isoformat(),
    ))
    conn.commit()
    conn.close()


def _get_results_from_db(file_id: str) -> Dict[str, str]:
    """获取某个论文保存的所有结果"""
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute("SELECT tab, result_text FROM results WHERE file_id = ?", (file_id,))
    rows = c.fetchall()
    conn.close()
    return {tab: text for tab, text in rows}


def _delete_paper_from_db(file_id: str):
    """删除论文及其结果"""
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute("DELETE FROM results WHERE file_id = ?", (file_id,))
    c.execute("DELETE FROM papers WHERE file_id = ?", (file_id,))
    conn.commit()
    conn.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：初始化数据库并从数据库恢复论文"""
    _init_db()
    _load_papers_from_db()
    yield


app = FastAPI(
    title="AI Paper Reader",
    description="AI 论文阅读助手 — 速览、总结、思维导图、实验汇总、翻译",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── 工具函数 ───

def _parse_and_store(file_id: str, filepath: str):
    """解析 PDF 并存入全局 store"""
    with PaperParser(filepath) as parser:
        meta = parser.get_metadata()
        text = parser.extract_full_text()
        sections = parser.extract_sections()
        pages = parser.extract_text_by_pages()

    paper_store[file_id] = {
        "path": filepath,
        "text": text,
        "meta": meta,
        "sections": sections,
        "pages": pages,
    }


def _save_paper_result_after_stream(file_id: str, tab: str, full_text: str):
    """流式结束后持久化结果"""
    _save_result_to_db(file_id, tab, full_text)


# ─── API 路由 ───

@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/papers")
async def list_papers():
    """列出最近上传的论文（用于首页历史记录）"""
    papers = []
    for file_id, store in paper_store.items():
        meta = store.get("meta", {})
        papers.append({
            "file_id": file_id,
            "title": meta.get("title", "未命名论文"),
            "filename": meta.get("filename", ""),
            "page_count": meta.get("page_count", 0),
            "text_length": len(store.get("text", "")),
            "upload_time": meta.get("upload_time", ""),
        })
    papers.sort(key=lambda x: x.get("upload_time", ""), reverse=True)
    return {"papers": papers[:50]}


@app.get("/api/paper/{file_id}/results")
async def get_paper_results(file_id: str):
    """获取某个论文已保存的 AI 分析结果"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")
    return {"results": _get_results_from_db(file_id)}


@app.delete("/api/paper/{file_id}")
async def delete_paper(file_id: str):
    """删除论文及其结果"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")
    filepath = paper_store[file_id]["path"]
    try:
        Path(filepath).unlink(missing_ok=True)
    except Exception:
        pass
    paper_store.pop(file_id, None)
    _delete_paper_from_db(file_id)
    return {"ok": True}


@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...)):
    """上传 PDF 论文"""
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "只支持 PDF 文件")

    content = await file.read()
    if len(content) > MAX_UPLOAD_SIZE:
        raise HTTPException(400, f"文件过大，最大 {MAX_UPLOAD_SIZE // 1024 // 1024}MB")

    file_id = uuid.uuid4().hex[:12]
    filepath = UPLOAD_DIR / f"{file_id}.pdf"
    filepath.write_bytes(content)

    _parse_and_store(file_id, str(filepath))
    store = paper_store[file_id]
    store["meta"]["filename"] = file.filename
    store["meta"]["upload_time"] = datetime.now(timezone.utc).isoformat()
    _save_paper_to_db(file_id, file.filename, store)

    return JSONResponse({
        "file_id": file_id,
        "meta": store["meta"],
        "text_length": len(store["text"]),
        "section_count": len(store["sections"]),
    })


@app.get("/api/paper/{file_id}/meta")
async def get_meta(file_id: str):
    """获取论文元数据"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")
    return paper_store[file_id]["meta"]


@app.get("/api/paper/{file_id}/text")
async def get_text(file_id: str, page: int = Query(None)):
    """获取论文文本（可按页）"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    store = paper_store[file_id]
    if page:
        pages = [p for p in store["pages"] if p["page"] == page]
        return pages[0] if pages else {"page": page, "text": ""}
    return {"text": store["text"], "pages": store["pages"]}


@app.get("/api/paper/{file_id}/sections")
async def get_sections(file_id: str):
    """获取论文章节"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")
    return paper_store[file_id]["sections"]


@app.get("/api/paper/{file_id}/pdf")
async def get_pdf(file_id: str):
    """获取原始 PDF 文件"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")
    return FileResponse(paper_store[file_id]["path"], media_type="application/pdf")


# ─── AI 功能路由 ───

@app.post("/api/paper/{file_id}/quick-scan")
async def quick_scan(file_id: str, stream: bool = Query(default=True)):
    """论文速览"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    text = paper_store[file_id]["text"]

    if stream:
        async def generate():
            full = []
            try:
                async for token in await ai_service.quick_scan(text, stream=True):
                    yield f"data: {json.dumps({'content': token})}\n\n"
                    full.append(token)
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
            finally:
                _save_paper_result_after_stream(file_id, 'quick-scan', ''.join(full))
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        result = await ai_service.quick_scan(text, stream=False)
        _save_paper_result_after_stream(file_id, 'quick-scan', result)
        return {"result": result}


@app.post("/api/paper/{file_id}/summary")
async def summary(file_id: str, stream: bool = Query(default=True)):
    """深度总结"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    text = paper_store[file_id]["text"]

    if stream:
        async def generate():
            full = []
            try:
                async for token in await ai_service.summary(text, stream=True):
                    yield f"data: {json.dumps({'content': token})}\n\n"
                    full.append(token)
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
            finally:
                _save_paper_result_after_stream(file_id, 'summary', ''.join(full))
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        result = await ai_service.summary(text, stream=False)
        _save_paper_result_after_stream(file_id, 'summary', result)
        return {"result": result}


@app.post("/api/paper/{file_id}/mindmap")
async def mindmap(file_id: str, stream: bool = Query(default=False)):
    """思维导图（Markdown 大纲）"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    text = paper_store[file_id]["text"]

    if stream:
        async def generate():
            full = []
            try:
                async for token in await ai_service.mindmap(text, stream=True):
                    yield f"data: {json.dumps({'content': token})}\n\n"
                    full.append(token)
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
            finally:
                _save_paper_result_after_stream(file_id, 'mindmap', ''.join(full))
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        result = await ai_service.mindmap(text, stream=False)
        _save_paper_result_after_stream(file_id, 'mindmap', result)
        return {"result": result}


@app.post("/api/paper/{file_id}/experiments")
async def experiments(file_id: str, stream: bool = Query(default=True)):
    """实验条件与结果汇总"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    text = paper_store[file_id]["text"]

    if stream:
        async def generate():
            full = []
            try:
                async for token in await ai_service.experiments(text, stream=True):
                    yield f"data: {json.dumps({'content': token})}\n\n"
                    full.append(token)
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
            finally:
                _save_paper_result_after_stream(file_id, 'experiments', ''.join(full))
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        result = await ai_service.experiments(text, stream=False)
        _save_paper_result_after_stream(file_id, 'experiments', result)
        return {"result": result}


@app.post("/api/paper/{file_id}/translate-snippet")
async def translate_snippet(file_id: str, text: str = Query(...)):
    """划词翻译"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    result = await ai_service.translate_snippet(text)
    return {"result": result}


@app.post("/api/paper/{file_id}/translate-full")
async def translate_full(file_id: str, stream: bool = Query(default=True)):
    """全文翻译"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    text = paper_store[file_id]["text"]

    if stream:
        async def generate():
            full = []
            try:
                async for token in ai_service.translate_full_stream(text):
                    yield f"data: {json.dumps({'content': token})}\n\n"
                    full.append(token)
            except Exception as e:
                yield f"data: {json.dumps({'error': 'Translation failed: ' + str(e)})}\n\n"
            finally:
                _save_paper_result_after_stream(file_id, 'translate', ''.join(full))
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        result = await ai_service.translate_full(text, stream=False)
        _save_paper_result_after_stream(file_id, 'translate', result)
        return {"result": result}


# ─── API 配置（Web UI 动态设置） ───

@app.post("/api/models")
async def fetch_models(req: ModelFetchRequest):
    """检测指定 API 的可用模型列表"""
    import httpx as ht
    url = req.base_url.rstrip("/") + "/models"
    try:
        async with ht.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, headers={"Authorization": f"Bearer {req.api_key}"})
            resp.raise_for_status()
            data = resp.json()
            models = []
            for m in data.get("data", []):
                models.append({"id": m.get("id", ""), "owned_by": m.get("owned_by", "")})
            models.sort(key=lambda x: x["id"])
            return {"models": models}
    except ht.HTTPStatusError as e:
        if e.response.status_code == 404:
            return {"models": [], "warning": "此 API 不支持 /models 端点，请手动输入模型名称"}
        raise HTTPException(status_code=400, detail=f"{url}: HTTP {e.response.status_code} - 请检查 Base URL 和 API Key 是否正确")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"请求 {url} 失败: {str(e)}")


@app.get("/api/config")
def get_config():
    return ai_service.get_config()


@app.post("/api/config")
def update_config(config: ConfigUpdate):
    ai_service.update_config(
        base_url=config.base_url,
        api_key=config.api_key,
        model=config.model,
        fast_base_url=config.fast_base_url,
        fast_api_key=config.fast_api_key,
        fast_model=config.fast_model,
    )
    return ai_service.get_config()


frontend_dir = Path(__file__).parent.parent / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        reload=os.getenv("UVICORN_RELOAD", "false").lower() == "true",
    )
