# ai_read — AI 论文阅读助手

一键上传论文 PDF，AI 帮你速览、总结、画思维导图、汇总实验、翻译全文。

![License](https://img.shields.io/badge/license-MIT-blue)
![Python](https://img.shields.io/badge/python-3.10+-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-green)

## 功能

| 功能 | 说明 |
|---|---|
| ⚡ **论文速览** | 一句话概括 + 核心贡献 + 方法概述 + 创新点评分 |
| 📝 **深度总结** | 六部分结构化总结：背景动机、方法、实验、结果、局限、启发 |
| 🧠 **思维导图** | AI 生成 Markdown 大纲 + 可视化思维导图 |
| 🔬 **实验汇总** | 数据集、实验设置、对比/消融实验结果表格化提取 |
| 🌐 **划词翻译** | 选中英文文本，弹窗即时翻译 |
| 📖 **全文翻译** | 完整论文翻译，自动分段处理 |

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置 API

复制并编辑环境变量：

```bash
cp .env.example .env
```

编辑 `.env`：

```env
# 任何 OpenAI 兼容 API 都可以用
AI_API_BASE_URL=http://your-api-host:8000/v1
AI_API_KEY=your-api-key
AI_MODEL_NAME=step-3.7         # 主力模型（速览/总结/思维导图/实验）
AI_MODEL_NAME_FAST=agnes        # 轻量模型（翻译）
```

### 3. 启动

```bash
cd backend
python main.py
```

浏览器打开 `http://localhost:8000`

## 项目结构

```
ai_read/
├── backend/
│   ├── main.py              # FastAPI 应用 + 路由
│   ├── pdf_parser.py        # PDF 解析（PyMuPDF）
│   ├── ai_service.py        # AI API 封装（OpenAI 兼容）
│   └── prompts/             # Prompt 模板
├── frontend/
│   ├── index.html           # 单页应用
│   ├── css/style.css        # 样式
│   └── js/
│       ├── app.js           # 主逻辑
│       └── marked.min.js    # Markdown 渲染
├── uploads/                 # 上传文件目录
├── requirements.txt
└── .env.example
```

## API 格式

后端兼容任何 OpenAI Chat Completions 格式的 API：

```
POST /v1/chat/completions
{
  "model": "step-3.7",
  "messages": [{"role": "user", "content": "..."}],
  "temperature": 0.3,
  "max_tokens": 4096,
  "stream": true
}
```

支持流式和非流式两种模式。切换到你的 Hermes / Agnes 或其他兼容服务，只需改 `.env` 中的 `AI_API_BASE_URL`。

## 技术栈

- **后端**：Python FastAPI + PyMuPDF + httpx
- **前端**：原生 HTML/CSS/JS + marked.js + markmap
- **AI**：OpenAI 兼容 API（Hermes step3.7 / Agnes 等）

## License

MIT
