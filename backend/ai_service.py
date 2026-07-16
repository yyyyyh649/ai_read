import os
import json
import asyncio
import logging
import httpx
from typing import Optional, AsyncGenerator

from prompts import (
    PROMPT_QUICK_SCAN,
    PROMPT_SUMMARY,
    PROMPT_MINDMAP,
    PROMPT_EXPERIMENTS,
    PROMPT_TRANSLATE_SNIPPET,
    PROMPT_FULL_TRANSLATION,
)

logger = logging.getLogger(__name__)
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
    logger.addHandler(handler)
logger.setLevel(logging.INFO)


class AIService:
    """OpenAI 兼容 API 服务，主力/辅助模型各自独立配置"""

    def __init__(self):
        # 主力模型配置
        self._main = {
            "base_url": os.getenv("AI_API_BASE_URL", "").rstrip("/"),
            "api_key": os.getenv("AI_API_KEY", ""),
            "model": os.getenv("AI_MODEL_NAME", ""),
        }
        # 辅助模型配置（独立，不填则回退到主力）
        self._fast = {
            "base_url": os.getenv("AI_API_BASE_URL_FAST", "").rstrip("/"),
            "api_key": os.getenv("AI_API_KEY_FAST", ""),
            "model": os.getenv("AI_MODEL_NAME_FAST", ""),
        }

    def _has_fast_config(self) -> bool:
        """辅助模型必须同时配置 base_url、api_key、model 三项才算有效"""
        return all([self._fast["base_url"], self._fast["api_key"], self._fast["model"]])

    def _resolve(self, use_fast: bool = False) -> dict:
        """解析实际使用的配置。要求辅助模型时，若 fast 未完整配置则整体回退到 main"""
        if use_fast and self._has_fast_config():
            return dict(self._fast)
        return dict(self._main)

    @property
    def base_url(self):
        return self._main["base_url"]

    @property
    def api_key(self):
        return self._main["api_key"]

    @property
    def model(self):
        return self._main["model"]

    @property
    def model_fast(self):
        return self._fast["model"] or self._main["model"]

    def update_config(self, base_url=None, api_key=None, model=None,
                      fast_base_url=None, fast_api_key=None, fast_model=None):
        """从 Web UI 更新配置（只更新传入的项）"""
        if base_url is not None:
            self._main["base_url"] = base_url.rstrip("/")
        if api_key is not None:
            self._main["api_key"] = api_key
        if model is not None:
            self._main["model"] = model
        if fast_base_url is not None:
            self._fast["base_url"] = fast_base_url.rstrip("/") if fast_base_url else ""
        if fast_api_key is not None:
            self._fast["api_key"] = fast_api_key
        if fast_model is not None:
            self._fast["model"] = fast_model

    def get_config(self):
        """获取当前配置（脱敏 api_key）"""
        def mask(key):
            if key and len(key) > 8:
                return key[:4] + "***" + key[-4:]
            return key
        return {
            "base_url": self._main["base_url"],
            "api_key": mask(self._main["api_key"]),
            "model": self._main["model"],
            "fast_base_url": self._fast["base_url"],
            "fast_api_key": mask(self._fast["api_key"]),
            "fast_model": self._fast["model"],
        }

    def _get_headers(self, use_fast=False):
        cfg = self._resolve(use_fast)
        return {
            "Authorization": f'Bearer {cfg["api_key"]}',
            "Content-Type": "application/json",
        }

    def _build_payload(self, prompt, stream=False, temperature=0.3, max_tokens=4096, use_fast=False):
        cfg = self._resolve(use_fast)
        return {
            "model": cfg["model"],
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": stream,
        }

    async def chat(self, prompt, temperature=0.3, max_tokens=4096, use_fast=False):
        payload = self._build_payload(prompt, stream=False, temperature=temperature, max_tokens=max_tokens, use_fast=use_fast)
        cfg = self._resolve(use_fast)
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(f'{cfg["base_url"]}/chat/completions', headers=self._get_headers(use_fast), json=payload)
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"]

    async def chat_stream(self, prompt, temperature=0.3, max_tokens=4096, use_fast=False):
        payload = self._build_payload(prompt, stream=True, temperature=temperature, max_tokens=max_tokens, use_fast=use_fast)
        cfg = self._resolve(use_fast)
        async with httpx.AsyncClient(timeout=300.0) as client:
            async with client.stream("POST", f'{cfg["base_url"]}/chat/completions', headers=self._get_headers(use_fast), json=payload) as resp:
                # 关键：先检查 HTTP 状态，否则 429/401 等错误会被 SSE 解析跳过，导致前端收到空内容
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        ds = line[6:]
                        if ds.strip() == "[DONE]":
                            break
                        try:
                            chunk = json.loads(ds)
                            content = ""
                            # 兼容多种流式/非流式返回格式
                            choice = chunk.get("choices", [{}])[0] if isinstance(chunk.get("choices"), list) else {}
                            if isinstance(choice, dict):
                                if "delta" in choice:
                                    content = choice["delta"].get("content", "") or ""
                                elif "message" in choice:
                                    content = choice["message"].get("content", "") or ""
                                elif "text" in choice:
                                    content = choice["text"] or ""
                            if not content and "content" in chunk and isinstance(chunk.get("content"), str):
                                content = chunk["content"]
                            if not content and "text" in chunk and isinstance(chunk.get("text"), str):
                                content = chunk["text"]
                            if content:
                                yield content
                        except (json.JSONDecodeError, KeyError, IndexError) as e:
                            logger.debug("Failed to parse SSE chunk: %s, error: %s", ds, e)
                            continue

    async def _stream_with_retry(self, prompt, max_tokens=4096, temperature=0.3, use_fast=False, retries=3, base_delay=1.0):
        """带重试的流式调用。免费模型常因限速/容量返回空内容，重试可显著提高成功率。"""
        last_exc = None
        for attempt in range(1, retries + 1):
            try:
                tokens_yielded = 0
                async for token in self.chat_stream(prompt, temperature=temperature, max_tokens=max_tokens, use_fast=use_fast):
                    yield token
                    tokens_yielded += 1
                if tokens_yielded == 0:
                    raise ValueError("AI 返回了空流（可能是免费模型限速或暂时不可用）")
                return
            except (httpx.HTTPStatusError, httpx.ConnectError, httpx.TimeoutException, ValueError) as e:
                last_exc = e
                status_code = getattr(getattr(e, "response", None), "status_code", None)
                is_rate_limit = status_code == 429 or "rate" in str(e).lower() or "limit" in str(e).lower()
                if attempt == retries:
                    logger.error("Stream failed after %d attempts: %s", retries, e)
                    raise last_exc
                delay = base_delay * (2 ** (attempt - 1)) if is_rate_limit else base_delay * 0.5
                logger.warning("Stream attempt %d/%d failed (status=%s, err=%s), retrying in %.1fs...",
                               attempt, retries, status_code, e, delay)
                await asyncio.sleep(delay)

    async def _chat_with_retry(self, prompt, max_tokens=4096, temperature=0.3, use_fast=False, retries=3, base_delay=1.0):
        """带重试的非流式调用"""
        last_exc = None
        for attempt in range(1, retries + 1):
            try:
                return await self.chat(prompt, temperature=temperature, max_tokens=max_tokens, use_fast=use_fast)
            except (httpx.HTTPStatusError, httpx.ConnectError, httpx.TimeoutException) as e:
                last_exc = e
                status_code = getattr(getattr(e, "response", None), "status_code", None)
                is_rate_limit = status_code == 429
                if attempt == retries:
                    logger.error("Chat failed after %d attempts: %s", retries, e)
                    raise last_exc
                delay = base_delay * (2 ** (attempt - 1)) if is_rate_limit else base_delay * 0.5
                logger.warning("Chat attempt %d/%d failed (status=%s, err=%s), retrying in %.1fs...",
                               attempt, retries, status_code, e, delay)
                await asyncio.sleep(delay)

    # ─── 各功能方法 ───
    async def quick_scan(self, paper_text, stream=False):
        prompt = PROMPT_QUICK_SCAN.format(paper_text=paper_text[:30000])
        return await self._respond(prompt, stream=stream, max_tokens=2048)

    async def summary(self, paper_text, stream=False):
        prompt = PROMPT_SUMMARY.format(paper_text=paper_text[:40000])
        return await self._respond(prompt, stream=stream, max_tokens=4096)

    async def mindmap(self, paper_text, stream=False):
        prompt = PROMPT_MINDMAP.format(paper_text=paper_text[:30000])
        return await self._respond(prompt, stream=stream, max_tokens=2048)

    async def experiments(self, paper_text, stream=False):
        prompt = PROMPT_EXPERIMENTS.format(paper_text=paper_text[:40000])
        # 实验汇总使用主模型，不使用辅助模型
        return await self._respond(prompt, stream=stream, max_tokens=4096, use_fast=False)

    async def translate_snippet(self, text):
        prompt = PROMPT_TRANSLATE_SNIPPET.format(text=text)
        return await self._chat_with_retry(prompt, temperature=0.1, max_tokens=2048, use_fast=True)

    async def translate_full(self, paper_text, stream=False):
        chunk_size = 20000
        if len(paper_text) <= chunk_size:
            prompt = PROMPT_FULL_TRANSLATION.format(paper_text=paper_text)
            return await self._respond(prompt, stream=stream, max_tokens=8192, use_fast=True)
        chunks = [paper_text[i:i+chunk_size] for i in range(0, len(paper_text), chunk_size)]
        results = []
        for chunk in chunks:
            prompt = PROMPT_FULL_TRANSLATION.format(paper_text=chunk)
            result = await self._chat_with_retry(prompt, max_tokens=8192, use_fast=True)
            if isinstance(result, str):
                results.append(result)
        return "\n\n---\n\n".join(results)

    async def translate_full_stream(self, paper_text):
        """逐块真流式翻译：每块的 token 一边生成一边吐出，不等全部块翻完再返回"""
        chunk_size = 20000
        chunks = [paper_text[i:i+chunk_size] for i in range(0, len(paper_text), chunk_size)]
        for idx, chunk in enumerate(chunks):
            if idx > 0:
                yield "\n\n---\n\n"
            prompt = PROMPT_FULL_TRANSLATION.format(paper_text=chunk)
            async for token in self._stream_with_retry(prompt, max_tokens=8192, use_fast=True):
                yield token

    async def _respond(self, prompt, stream=False, max_tokens=4096, use_fast=False):
        if stream:
            return self._stream_with_retry(prompt, max_tokens=max_tokens, use_fast=use_fast)
        return await self._chat_with_retry(prompt, max_tokens=max_tokens, use_fast=use_fast)


ai_service = AIService()
