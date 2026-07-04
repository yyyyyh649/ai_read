"""
AI 服务模块 — 封装 OpenAI 兼容 API 调用
支持运行时动态配置（通过 Web UI 设置）
"""

import os
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


class AIService:
    """OpenAI 兼容 API 服务，支持运行时动态更新配置"""

    def __init__(self):
        self._config = {
            "base_url": os.getenv("AI_API_BASE_URL", "").rstrip("/"),
            "api_key": os.getenv("AI_API_KEY", ""),
            "model": os.getenv("AI_MODEL_NAME", "step-3.7"),
            "model_fast": os.getenv("AI_MODEL_NAME_FAST", "agnes"),
        }

    @property
    def base_url(self):
        return self._config["base_url"]

    @property
    def api_key(self):
        return self._config["api_key"]

    @property
    def model(self):
        return self._config["model"]

    @property
    def model_fast(self):
        return self._config["model_fast"]

    def update_config(self, base_url=None, api_key=None, model=None, model_fast=None):
        """从 Web UI 更新配置（只更新传入的项）"""
        if base_url is not None:
            self._config["base_url"] = base_url.rstrip("/")
        if api_key is not None:
            self._config["api_key"] = api_key
        if model is not None:
            self._config["model"] = model
        if model_fast is not None:
            self._config["model_fast"] = model_fast

    def get_config(self):
        """获取当前配置（隐藏 api_key 大部分字符）"""
        cfg = dict(self._config)
        key = cfg["api_key"]
        if key and len(key) > 8:
            cfg["api_key"] = key[:4] + "***" + key[-4:]
        return cfg

    def _get_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _build_payload(
        self,
        prompt: str,
        stream: bool = False,
        temperature: float = 0.3,
        max_tokens: int = 4096,
        use_fast: bool = False,
    ) -> dict:
        return {
            "model": self.model_fast if use_fast else self.model,
            "messages": [
                {"role": "user", "content": prompt}
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": stream,
        }

    async def chat(
        self,
        prompt: str,
        temperature: float = 0.3,
        max_tokens: int = 4096,
        use_fast: bool = False,
    ) -> str:
        """普通对话（非流式）"""
        payload = self._build_payload(
            prompt, stream=False,
            temperature=temperature,
            max_tokens=max_tokens,
            use_fast=use_fast,
        )

        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(
                f"{self.base_url}/chat/completions",
                headers=self._get_headers(),
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"]

    async def chat_stream(
        self,
        prompt: str,
        temperature: float = 0.3,
        max_tokens: int = 4096,
        use_fast: bool = False,
    ) -> AsyncGenerator[str, None]:
        """流式对话 — 逐 token 返回"""
        payload = self._build_payload(
            prompt, stream=True,
            temperature=temperature,
            max_tokens=max_tokens,
            use_fast=use_fast,
        )

        async with httpx.AsyncClient(timeout=300.0) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/chat/completions",
                headers=self._get_headers(),
                json=payload,
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        data_str = line[6:]
                        if data_str.strip() == "[DONE]":
                            break
                        import json
                        try:
                            chunk = json.loads(data_str)
                            delta = chunk["choices"][0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                yield content
                        except (json.JSONDecodeError, KeyError, IndexError):
                            continue

    # ─── 各功能方法 ───

    async def quick_scan(self, paper_text: str, stream: bool = False):
        prompt = PROMPT_QUICK_SCAN.format(paper_text=paper_text[:30000])
        return await self._respond(prompt, stream=stream, max_tokens=2048)

    async def summary(self, paper_text: str, stream: bool = False):
        prompt = PROMPT_SUMMARY.format(paper_text=paper_text[:40000])
        return await self._respond(prompt, stream=stream, max_tokens=4096)

    async def mindmap(self, paper_text: str, stream: bool = False):
        prompt = PROMPT_MINDMAP.format(paper_text=paper_text[:30000])
        return await self._respond(prompt, stream=stream, max_tokens=2048)

    async def experiments(self, paper_text: str, stream: bool = False):
        prompt = PROMPT_EXPERIMENTS.format(paper_text=paper_text[:40000])
        return await self._respond(prompt, stream=stream, max_tokens=4096)

    async def translate_snippet(self, text: str) -> str:
        prompt = PROMPT_TRANSLATE_SNIPPET.format(text=text)
        return await self.chat(prompt, temperature=0.1, max_tokens=2048, use_fast=True)

    async def translate_full(self, paper_text: str, stream: bool = False):
        chunk_size = 20000
        if len(paper_text) <= chunk_size:
            prompt = PROMPT_FULL_TRANSLATION.format(paper_text=paper_text)
            return await self._respond(prompt, stream=stream, max_tokens=8192, use_fast=True)
        else:
            chunks = [
                paper_text[i:i + chunk_size]
                for i in range(0, len(paper_text), chunk_size)
            ]
            results = []
            for i, chunk in enumerate(chunks):
                prompt = PROMPT_FULL_TRANSLATION.format(paper_text=chunk)
                result = await self._respond(prompt, stream=False, max_tokens=8192, use_fast=True)
                if isinstance(result, str):
                    results.append(result)
            return "\n\n---\n\n".join(results)

    async def _respond(self, prompt, stream=False, max_tokens=4096, use_fast=False):
        if stream:
            return self.chat_stream(prompt, max_tokens=max_tokens, use_fast=use_fast)
        else:
            return await self.chat(prompt, max_tokens=max_tokens, use_fast=use_fast)


# 单例
ai_service = AIService()
