"""
AI Paper Reader — FastAPI 后端
论文 AI 阅读助手：速览、总结、思维导图、实验汇总、划词翻译、全文翻译
"""

import os
import uuid
import json
import hmac
import sqlite3
import logging
from pathlib import Path
from datetime import datetime, timezone
from contextlib import asynccontextmanager, closing
from typing import Optional, List, Dict, Any

from dotenv import load_dotenv
load_dotenv(dotenv_path="../.env")

from fastapi import FastAPI, UploadFile, File, HTTPException, Query, Header, Depends
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from pdf_parser import PaperParser
from ai_service import ai_service

from pydantic import BaseModel, Field

logger = logging.getLogger("ai_read")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)


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


class TranslateRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=10000)


# ─── 配置 ───
UPLOAD_DIR = Path(__file__).parent.parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
DATA_DIR = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "papers.db"
MAX_UPLOAD_SIZE = int(os.getenv("MAX_UPLOAD_SIZE_MB", "50")) * 1024 * 1024

# 鉴权：配置 ADMIN_TOKEN 后，敏感接口需要 Bearer token
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "").strip()

# CORS：从环境变量读取允许的来源
_allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "*").strip()
if _allowed_origins_env == "*":
    ALLOWED_ORIGINS: list[str] = ["*"]
else:
    ALLOWED_ORIGINS = [o.strip() for o in _allowed_origins_env.split(",") if o.strip()]

# 全局存储：{file_id: {"path": str, "text": str, "meta": dict, "sections": list, "pages": list}}
paper_store: dict = {}


# ─── 鉴权 ───

def _extract_bearer(authorization: Optional[str]) -> str:
    """从 Authorization 头提取 token，支持 'Bearer xxx' 和裸 token"""
    if not authorization:
        return ""
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return authorization.strip()


def require_auth(
    authorization: Optional[str] = Header(None),
    token: Optional[str] = Query(None, description="备用：通过 query 传 token（用于 iframe / EventSource 等无法设置请求头的场景）"),
):
    """FastAPI 依赖：若服务端配置了 ADMIN_TOKEN，则校验 Authorization 头或 ?token= 查询参数"""
    if not ADMIN_TOKEN:
        return  # 未启用鉴权
    # 优先取请求头，其次取 query 参数
    candidate = _extract_bearer(authorization) or (token or "")
    if not candidate:
        raise HTTPException(status_code=401, detail="需要鉴权：请在请求头中提供 Authorization: Bearer <token> 或在 URL 中带 ?token=<token>")
    # 常量时间比较，避免计时侧信道
    if not hmac.compare_digest(candidate, ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail="鉴权失败：token 不正确")


# ─── SQLite 持久化（使用上下文管理器避免连接泄漏） ───

def _init_db():
    """初始化 SQLite 数据库，持久化论文元数据和 AI 分析结果"""
    with closing(sqlite3.connect(str(DB_PATH))) as conn:
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


def _load_papers_from_db():
    """启动时从数据库恢复论文到内存"""
    with closing(sqlite3.connect(str(DB_PATH))) as conn:
        c = conn.cursor()
        c.execute("SELECT * FROM papers ORDER BY upload_time DESC")
        rows = c.fetchall()

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
    with closing(sqlite3.connect(str(DB_PATH))) as conn:
        with conn:  # 事务
            meta = store.get("meta", {})
            conn.execute('''
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


def _save_result_to_db(file_id: str, tab: str, result_text: str):
    """保存某个论文的某个 tab 分析结果"""
    if not result_text:
        return
    with closing(sqlite3.connect(str(DB_PATH))) as conn:
        with conn:
            # 先删除旧结果，只保留最新
            conn.execute("DELETE FROM results WHERE file_id = ? AND tab = ?", (file_id, tab))
            conn.execute('''
                INSERT INTO results (file_id, tab, result_text, created_time)
                VALUES (?, ?, ?, ?)
            ''', (
                file_id,
                tab,
                result_text,
                datetime.now(timezone.utc).isoformat(),
            ))


def _get_results_from_db(file_id: str) -> Dict[str, str]:
    """获取某个论文保存的所有结果"""
    with closing(sqlite3.connect(str(DB_PATH))) as conn:
        c = conn.cursor()
        c.execute("SELECT tab, result_text FROM results WHERE file_id = ?", (file_id,))
        rows = c.fetchall()
    return {tab: text for tab, text in rows}


def _delete_paper_from_db(file_id: str):
    """删除论文及其结果"""
    with closing(sqlite3.connect(str(DB_PATH))) as conn:
        with conn:
            conn.execute("DELETE FROM results WHERE file_id = ?", (file_id,))
            conn.execute("DELETE FROM papers WHERE file_id = ?", (file_id,))


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：初始化数据库并从数据库恢复论文"""
    _init_db()
    _load_papers_from_db()
    if ADMIN_TOKEN:
        logger.info("ADMIN_TOKEN 已配置，敏感接口启用鉴权")
    else:
        logger.warning("ADMIN_TOKEN 未配置，敏感接口对外开放（仅建议本地开发）")
    if ALLOWED_ORIGINS == ["*"]:
        logger.warning("ALLOWED_ORIGINS=*，CORS 完全开放（仅建议本地开发）")
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
    allow_origins=ALLOWED_ORIGINS,
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


def _safe_error_message(exc: Exception) -> str:
    """对外返回的脱敏错误信息（不暴露上游 URL / 状态码细节）"""
    # 已经是 HTTPException 的情况由 FastAPI 处理
    return "AI 服务暂时不可用，请稍后重试或检查 API 配置"


def _check_ai_configured(use_fast: bool = False) -> Optional[str]:
    """检查 AI 配置是否完整，返回错误提示字符串；返回 None 表示配置 OK"""
    cfg = ai_service._resolve(use_fast)
    missing = []
    if not cfg.get("base_url"):
        missing.append("API Base URL")
    if not cfg.get("api_key"):
        missing.append("API Key")
    if not cfg.get("model"):
        missing.append("模型名称")
    if missing:
        role = "辅助模型" if use_fast else "主力模型"
        return f"{role}未配置完整（缺少：{ '、'.join(missing) }），请在右上角 ⚙ 设置中填写后重试"
    return None


# ─── API 路由 ───

@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/papers")
async def list_papers(_=Depends(require_auth)):
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
async def get_paper_results(file_id: str, _=Depends(require_auth)):
    """获取某个论文已保存的 AI 分析结果"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")
    return {"results": _get_results_from_db(file_id)}


@app.delete("/api/paper/{file_id}")
async def delete_paper(file_id: str, _=Depends(require_auth)):
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
async def upload_pdf(file: UploadFile = File(...), _=Depends(require_auth)):
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
async def get_meta(file_id: str, _=Depends(require_auth)):
    """获取论文元数据"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")
    return paper_store[file_id]["meta"]


@app.get("/api/paper/{file_id}/text")
async def get_text(file_id: str, page: int = Query(None), _=Depends(require_auth)):
    """获取论文文本（可按页）"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    store = paper_store[file_id]
    if page:
        pages = [p for p in store["pages"] if p["page"] == page]
        return pages[0] if pages else {"page": page, "text": ""}
    return {"text": store["text"], "pages": store["pages"]}


@app.get("/api/paper/{file_id}/sections")
async def get_sections(file_id: str, _=Depends(require_auth)):
    """获取论文章节"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")
    return paper_store[file_id]["sections"]


@app.get("/api/paper/{file_id}/pdf")
async def get_pdf(file_id: str, _=Depends(require_auth)):
    """获取原始 PDF 文件"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")
    return FileResponse(paper_store[file_id]["path"], media_type="application/pdf")


# ─── AI 功能路由 ───

@app.post("/api/paper/{file_id}/quick-scan")
async def quick_scan(file_id: str, stream: bool = Query(default=True), _=Depends(require_auth)):
    """论文速览"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    cfg_err = _check_ai_configured(use_fast=False)
    if cfg_err:
        if stream:
            async def _cfg_err_stream():
                yield f"data: {json.dumps({'error': cfg_err})}\n\n"
                yield "data: [DONE]\n\n"
            return StreamingResponse(_cfg_err_stream(), media_type="text/event-stream")
        raise HTTPException(status_code=400, detail=cfg_err)

    text = paper_store[file_id]["text"]

    if stream:
        async def generate():
            full = []
            try:
                async for token in await ai_service.quick_scan(text, stream=True):
                    yield f"data: {json.dumps({'content': token})}\n\n"
                    full.append(token)
            except Exception as e:
                logger.exception("quick-scan stream failed for %s", file_id)
                yield f"data: {json.dumps({'error': _safe_error_message(e)})}\n\n"
            finally:
                _save_paper_result_after_stream(file_id, 'quick-scan', ''.join(full))
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        try:
            result = await ai_service.quick_scan(text, stream=False)
        except Exception as e:
            logger.exception("quick-scan failed for %s", file_id)
            raise HTTPException(status_code=502, detail=_safe_error_message(e))
        _save_paper_result_after_stream(file_id, 'quick-scan', result)
        return {"result": result}


@app.post("/api/paper/{file_id}/summary")
async def summary(file_id: str, stream: bool = Query(default=True), _=Depends(require_auth)):
    """深度总结"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    cfg_err = _check_ai_configured(use_fast=False)
    if cfg_err:
        if stream:
            async def _cfg_err_stream():
                yield f"data: {json.dumps({'error': cfg_err})}\n\n"
                yield "data: [DONE]\n\n"
            return StreamingResponse(_cfg_err_stream(), media_type="text/event-stream")
        raise HTTPException(status_code=400, detail=cfg_err)

    text = paper_store[file_id]["text"]

    if stream:
        async def generate():
            full = []
            try:
                async for token in await ai_service.summary(text, stream=True):
                    yield f"data: {json.dumps({'content': token})}\n\n"
                    full.append(token)
            except Exception as e:
                logger.exception("summary stream failed for %s", file_id)
                yield f"data: {json.dumps({'error': _safe_error_message(e)})}\n\n"
            finally:
                _save_paper_result_after_stream(file_id, 'summary', ''.join(full))
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        try:
            result = await ai_service.summary(text, stream=False)
        except Exception as e:
            logger.exception("summary failed for %s", file_id)
            raise HTTPException(status_code=502, detail=_safe_error_message(e))
        _save_paper_result_after_stream(file_id, 'summary', result)
        return {"result": result}


@app.post("/api/paper/{file_id}/mindmap")
async def mindmap(file_id: str, stream: bool = Query(default=False), _=Depends(require_auth)):
    """思维导图（Markdown 大纲）"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    cfg_err = _check_ai_configured(use_fast=False)
    if cfg_err:
        if stream:
            async def _cfg_err_stream():
                yield f"data: {json.dumps({'error': cfg_err})}\n\n"
                yield "data: [DONE]\n\n"
            return StreamingResponse(_cfg_err_stream(), media_type="text/event-stream")
        raise HTTPException(status_code=400, detail=cfg_err)

    text = paper_store[file_id]["text"]

    if stream:
        async def generate():
            full = []
            try:
                async for token in await ai_service.mindmap(text, stream=True):
                    yield f"data: {json.dumps({'content': token})}\n\n"
                    full.append(token)
            except Exception as e:
                logger.exception("mindmap stream failed for %s", file_id)
                yield f"data: {json.dumps({'error': _safe_error_message(e)})}\n\n"
            finally:
                _save_paper_result_after_stream(file_id, 'mindmap', ''.join(full))
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        try:
            result = await ai_service.mindmap(text, stream=False)
        except Exception as e:
            logger.exception("mindmap failed for %s", file_id)
            raise HTTPException(status_code=502, detail=_safe_error_message(e))
        _save_paper_result_after_stream(file_id, 'mindmap', result)
        return {"result": result}


@app.post("/api/paper/{file_id}/experiments")
async def experiments(file_id: str, stream: bool = Query(default=True), _=Depends(require_auth)):
    """实验条件与结果汇总"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    # 配置预检查：在调用 AI 前明确告知配置缺失，而不是泛化的"AI 不可用"
    cfg_err = _check_ai_configured(use_fast=False)
    if cfg_err:
        if stream:
            async def _cfg_err_stream():
                yield f"data: {json.dumps({'error': cfg_err})}\n\n"
                yield "data: [DONE]\n\n"
            return StreamingResponse(_cfg_err_stream(), media_type="text/event-stream")
        raise HTTPException(status_code=400, detail=cfg_err)

    text = paper_store[file_id]["text"]

    if stream:
        async def generate():
            full = []
            try:
                async for token in await ai_service.experiments(text, stream=True):
                    yield f"data: {json.dumps({'content': token})}\n\n"
                    full.append(token)
            except Exception as e:
                logger.exception("experiments stream failed for %s", file_id)
                yield f"data: {json.dumps({'error': _safe_error_message(e)})}\n\n"
            finally:
                _save_paper_result_after_stream(file_id, 'experiments', ''.join(full))
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        try:
            result = await ai_service.experiments(text, stream=False)
        except Exception as e:
            logger.exception("experiments failed for %s", file_id)
            raise HTTPException(status_code=502, detail=_safe_error_message(e))
        _save_paper_result_after_stream(file_id, 'experiments', result)
        return {"result": result}


@app.post("/api/paper/{file_id}/translate-snippet")
async def translate_snippet(file_id: str, body: TranslateRequest, _=Depends(require_auth)):
    """划词翻译（POST body 传 text，避免 URL 长度限制和日志泄露）"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    cfg_err = _check_ai_configured(use_fast=True)
    if cfg_err:
        raise HTTPException(status_code=400, detail=cfg_err)

    try:
        result = await ai_service.translate_snippet(body.text)
    except Exception as e:
        logger.exception("translate-snippet failed for %s", file_id)
        raise HTTPException(status_code=502, detail=_safe_error_message(e))
    return {"result": result}


@app.post("/api/paper/{file_id}/translate-full")
async def translate_full(file_id: str, stream: bool = Query(default=True), _=Depends(require_auth)):
    """全文翻译"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    cfg_err = _check_ai_configured(use_fast=True)
    if cfg_err:
        if stream:
            async def _cfg_err_stream():
                yield f"data: {json.dumps({'error': cfg_err})}\n\n"
                yield "data: [DONE]\n\n"
            return StreamingResponse(_cfg_err_stream(), media_type="text/event-stream")
        raise HTTPException(status_code=400, detail=cfg_err)

    text = paper_store[file_id]["text"]

    if stream:
        async def generate():
            full = []
            try:
                async for token in ai_service.translate_full_stream(text):
                    yield f"data: {json.dumps({'content': token})}\n\n"
                    full.append(token)
            except Exception as e:
                logger.exception("translate-full stream failed for %s", file_id)
                yield f"data: {json.dumps({'error': _safe_error_message(e)})}\n\n"
            finally:
                _save_paper_result_after_stream(file_id, 'translate', ''.join(full))
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        try:
            result = await ai_service.translate_full(text, stream=False)
        except Exception as e:
            logger.exception("translate-full failed for %s", file_id)
            raise HTTPException(status_code=502, detail=_safe_error_message(e))
        _save_paper_result_after_stream(file_id, 'translate', result)
        return {"result": result}


# ─── 独立划词翻译（不需要 file_id，前端"🌐 划词翻译" tab 用） ───

@app.post("/api/translate")
async def translate_any(body: TranslateRequest, _=Depends(require_auth)):
    """任意文本翻译：粘贴一段、一句、一词都可以，返回原文 + 译文"""
    cfg_err = _check_ai_configured(use_fast=True)
    if cfg_err:
        raise HTTPException(status_code=400, detail=cfg_err)
    try:
        result = await ai_service.translate_snippet(body.text)
    except Exception as e:
        logger.exception("translate-any failed")
        raise HTTPException(status_code=502, detail=_safe_error_message(e))
    return {"original": body.text, "result": result}


# ─── API 配置（Web UI 动态设置） ───

@app.post("/api/models")
async def fetch_models(req: ModelFetchRequest, _=Depends(require_auth)):
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
        raise HTTPException(status_code=400, detail=f"请求 {url} 失败：HTTP {e.response.status_code}，请检查 Base URL 和 API Key")
    except Exception as e:
        logger.exception("fetch_models failed for %s", url)
        raise HTTPException(status_code=400, detail=f"请求 {url} 失败：{type(e).__name__}")


@app.get("/api/config")
def get_config():
    """获取当前配置（脱敏 api_key）。此接口公开，便于前端判断是否需要鉴权。"""
    cfg = ai_service.get_config()
    cfg["auth_required"] = bool(ADMIN_TOKEN)
    return cfg


@app.post("/api/config")
def update_config(config: ConfigUpdate, _=Depends(require_auth)):
    ai_service.update_config(
        base_url=config.base_url,
        api_key=config.api_key,
        model=config.model,
        fast_base_url=config.fast_base_url,
        fast_api_key=config.fast_api_key,
        fast_model=config.fast_model,
    )
    cfg = ai_service.get_config()
    cfg["auth_required"] = bool(ADMIN_TOKEN)
    return cfg


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
