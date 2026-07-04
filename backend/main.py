"""
AI Paper Reader — FastAPI 后端
论文 AI 阅读助手：速览、总结、思维导图、实验汇总、划词翻译、全文翻译
"""

import os
import uuid
import shutil
from pathlib import Path
from contextlib import asynccontextmanager

from dotenv import load_dotenv
load_dotenv(dotenv_path="../.env")

from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import json

from pdf_parser import PaperParser
from ai_service import ai_service

from pydantic import BaseModel, Field
from typing import Optional

class ConfigUpdate(BaseModel):
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None
    fast_base_url: Optional[str] = None
    fast_api_key: Optional[str] = None
    fast_model: Optional[str] = None

# ─── 配置 ───
UPLOAD_DIR = Path(__file__).parent.parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
MAX_UPLOAD_SIZE = int(os.getenv("MAX_UPLOAD_SIZE_MB", "50")) * 1024 * 1024

# 全局存储：{file_id: {"path": str, "text": str, "meta": dict, "sections": list, "pages": list}}
paper_store: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期"""
    # 启动时清理旧的 uploads
    for f in UPLOAD_DIR.glob("*"):
        if f.is_file():
            f.unlink()
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


# ─── API 路由 ───

@app.get("/api/health")
async def health():
    return {"status": "ok"}


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

    return JSONResponse({
        "file_id": file_id,
        "meta": paper_store[file_id]["meta"],
        "text_length": len(paper_store[file_id]["text"]),
        "section_count": len(paper_store[file_id]["sections"]),
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
            async for token in await ai_service.quick_scan(text, stream=True):
                yield f"data: {json.dumps({'content': token})}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        result = await ai_service.quick_scan(text, stream=False)
        return {"result": result}


@app.post("/api/paper/{file_id}/summary")
async def summary(file_id: str, stream: bool = Query(default=True)):
    """深度总结"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    text = paper_store[file_id]["text"]

    if stream:
        async def generate():
            async for token in await ai_service.summary(text, stream=True):
                yield f"data: {json.dumps({'content': token})}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        result = await ai_service.summary(text, stream=False)
        return {"result": result}


@app.post("/api/paper/{file_id}/mindmap")
async def mindmap(file_id: str, stream: bool = Query(default=False)):
    """思维导图（Markdown 大纲）"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    text = paper_store[file_id]["text"]

    if stream:
        async def generate():
            async for token in await ai_service.mindmap(text, stream=True):
                yield f"data: {json.dumps({'content': token})}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        result = await ai_service.mindmap(text, stream=False)
        return {"result": result}


@app.post("/api/paper/{file_id}/experiments")
async def experiments(file_id: str, stream: bool = Query(default=True)):
    """实验条件与结果汇总"""
    if file_id not in paper_store:
        raise HTTPException(404, "论文未找到")

    text = paper_store[file_id]["text"]

    if stream:
        async def generate():
            async for token in await ai_service.experiments(text, stream=True):
                yield f"data: {json.dumps({'content': token})}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        result = await ai_service.experiments(text, stream=False)
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
            result = await ai_service.translate_full(text, stream=False)
            # 由于分批翻译用非流式，这里模拟流式输出
            if isinstance(result, str):
                for char in result:
                    yield f"data: {json.dumps({'content': char})}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        result = await ai_service.translate_full(text, stream=False)
        return {"result": result}


# ─── API 配置（Web UI 动态设置） ───
class ModelFetchRequest(BaseModel):
    base_url: str
    api_key: str

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
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch models: {str(e)}")


# ─── 静态文件（前端） ───

# ─── API 配置（Web UI 动态设置） ───

@app.get("/api/config")
@app.get("/api/config")
def get_config():
    return ai_service.get_config()

@app.post("/api/config")
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
        reload=True,
    )
