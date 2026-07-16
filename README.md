# ai_read — AI 论文阅读助手

> 一键上传论文 PDF，AI 帮你速览、深度总结、画思维导图、汇总实验、划词翻译、全文翻译。
> 兼容任何 OpenAI Chat Completions 格式的 API（OpenAI / DeepSeek / Hermes / Agnes / 自建 vLLM …）。

![License](https://img.shields.io/badge/license-MIT-blue)
![Python](https://img.shields.io/badge/python-3.10+-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-green)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED)

---

## 目录

- [项目简介](#项目简介)
- [功能一览](#功能一览)
- [技术栈](#技术栈)
- [架构图](#架构图)
- [功能截图](#功能截图)
- [快速开始](#快速开始)
- [Docker 部署](#docker-部署)
- [配置到自己的域名](#配置到自己的域名)
- [环境变量](#环境变量)
- [安全建议](#安全建议)
- [项目结构](#项目结构)
- [API 一览](#api-一览)
- [未来规划](#未来规划)
- [License](#license)

---

## 项目简介

`ai_read` 是一个**自托管的 AI 论文阅读助手**，专为研究生、科研工作者、技术读者设计。它把"读论文"这件事拆成了 6 个高频动作——速览 / 总结 / 思维导图 / 实验汇总 / 划词翻译 / 全文翻译，每个动作都封装成一条流式 API，前端以单页应用方式呈现。

设计理念：

- **自带 PDF 预览**：左侧原生 PDF 预览，右侧 AI 分析结果，并排阅读不打断思路。
- **流式输出**：所有 AI 接口都支持 SSE 流式响应，token 边生成边显示。
- **结果持久化**：分析结果存 SQLite，刷新页面 / 重启服务后历史结果还在。
- **多模型协同**：主力模型负责"重活"（总结/实验），辅助模型负责"快活"（翻译），省钱省时。
- **零依赖前端**：原生 HTML/CSS/JS + marked.js + markmap，无构建步骤。
- **OpenAI 兼容**：任何符合 `POST /v1/chat/completions` 协议的服务都能直接接入。

## 功能一览

| 功能 | 说明 |
|---|---|
| ⚡ **论文速览** | 一句话概括 + 核心贡献 + 方法概述 + 关键发现 + 创新点评分（1-10） |
| 📝 **深度总结** | 六部分结构化总结：背景动机 / 方法 / 实验设计 / 主要结果 / 局限性 / 个人思考 |
| 🧠 **思维导图** | AI 生成 Markdown 大纲 + markmap 可视化思维导图 |
| 🔬 **实验汇总** | 数据集 / 实验设置 / 对比实验 / 消融实验 表格化提取 |
| 🌐 **划词翻译** | 独立翻译工作台：粘贴任意文本（一段、一句、一词都行），原文 + 译文并排显示，两侧均可一键复制 |
| 📖 **全文翻译** | 完整论文翻译，自动按 20K 字符分块流式处理，分隔符分段 |
| 📚 **历史记录** | 最近 50 篇论文持久化，点击即可恢复所有 AI 分析结果 |

## 技术栈

| 层 | 技术 |
|---|---|
| **后端** | Python 3.10+、FastAPI 0.115、Uvicorn、PyMuPDF 1.25（PDF 解析）、httpx（异步 HTTP）、python-dotenv |
| **数据库** | SQLite 3（零配置持久化） |
| **前端** | 原生 HTML5 / CSS3 / ES2017+、marked.js（Markdown 渲染）、markmap（思维导图）、highlight.js（代码高亮） |
| **AI** | 任何 OpenAI Chat Completions 兼容 API（OpenAI / DeepSeek / Hermes step3.7 / Agnes / vLLM / Ollama 等） |
| **部署** | Docker、docker-compose、Nginx 反代（可选） |

## 架构图

```mermaid
flowchart LR
    subgraph Browser["🌐 浏览器（单页应用）"]
        UI["index.html<br/>+ app.js"]
        PDF["PDF 预览 iframe"]
    end

    subgraph Server["🖥️ FastAPI 后端 (uvicorn)"]
        Router["路由层<br/>/api/*"]
        Parser["PaperParser<br/>(PyMuPDF)"]
        AIService["AIService<br/>(httpx 流式)"]
        DB[("SQLite<br/>papers.db")]
        Store["paper_store<br/>(内存缓存)"]
        FS[("uploads/<br/>*.pdf")]
    end

    subgraph LLM["🤖 OpenAI 兼容 API"]
        Main["主力模型<br/>step-3.7 / gpt-4o"]
        Fast["辅助模型<br/>agnes / gpt-4o-mini"]
    end

    UI -->|上传 PDF / 调用 AI| Router
    PDF -->|GET /api/paper/{id}/pdf| Router
    Router --> Parser
    Parser --> FS
    Router <--> Store
    Store <--> DB
    Router -->|SSE 流式| AIService
    AIService -->|chat/completions| Main
    AIService -->|chat/completions| Fast
    AIService -.->|结果落库| DB
```

数据流要点：

1. **上传**：`POST /api/upload` → PyMuPDF 解析 → `paper_store`（内存）+ `papers` 表（SQLite）+ `uploads/{file_id}.pdf`（磁盘）。
2. **AI 调用**：`POST /api/paper/{id}/{feature}?stream=true` → 从 `paper_store` 取文本 → 拼接 prompt → httpx 流式调用 LLM → SSE 边吐边写 → 流结束落 `results` 表。
3. **历史恢复**：`GET /api/paper/{id}/results` 一次拉回所有 tab 的已保存结果。

## 功能截图

> 截图待补充。建议自行运行后把以下界面截图放到 `docs/screenshots/` 下，再替换下面的占位：
>
> | 文件名 | 内容 |
> |---|---|
> | `docs/screenshots/upload.png` | 上传与首页 |
> | `docs/screenshots/quick-scan.png` | 论文速览 |
> | `docs/screenshots/summary.png` | 深度总结 |
> | `docs/screenshots/mindmap.png` | 思维导图 |
> | `docs/screenshots/experiments.png` | 实验汇总 |
> | `docs/screenshots/translate-snippet.png` | 划词翻译工作台 |
> | `docs/screenshots/translate-full.png` | 全文翻译 |
>
> 然后在 README 里这样引用：`![速览](docs/screenshots/quick-scan.png)`

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置 API

```bash
cp .env.example .env
```

编辑 `.env`：

```env
# 任何 OpenAI 兼容 API 都可以用
AI_API_BASE_URL=https://api.openai.com/v1
AI_API_KEY=sk-xxxxxxxxxxxxxxxx
AI_MODEL_NAME=gpt-4o-mini

# 辅助模型（可选，留空回退到主模型）
AI_API_BASE_URL_FAST=
AI_API_KEY_FAST=
AI_MODEL_NAME_FAST=

# 安全（生产环境强烈建议配置，详见"安全建议"章节）
ADMIN_TOKEN=
ALLOWED_ORIGINS=*
```

> 也可以不写 `.env`，启动后在网页右上角点 ⚙ 图标直接在 UI 里配置（配置仅保存在进程内存和浏览器 localStorage）。

### 3. 启动

```bash
cd backend
python main.py
```

浏览器打开 <http://localhost:8000>。

## Docker 部署

仓库已带 `Dockerfile` 和 `docker-compose.yml`，一行命令起服务：

```bash
# 1. 准备环境变量
cp .env.example .env
# 编辑 .env 填入你的 API Key、ADMIN_TOKEN、ALLOWED_ORIGINS

# 2. 一键启动
docker compose up -d --build

# 查看日志
docker compose logs -f ai_read

# 停止
docker compose down
```

默认暴露 `8000` 端口。`uploads/` 和 `data/` 会以命名卷的形式持久化（`ai_read_uploads`、`ai_read_data`），容器重建后论文与历史结果不丢。

如果不想用 compose，直接用 `docker run`：

```bash
docker build -t ai_read .
docker run -d --name ai_read \
  -p 8000:8000 \
  -v $(pwd)/.env:/app/.env:ro \
  -v ai_read_uploads:/app/uploads \
  -v ai_read_data:/app/data \
  --restart unless-stopped \
  ai_read
```

## 配置到自己的域名

部署到个人服务器后，把服务暴露到自有域名通常有两种做法：

### 方案 A：Nginx 反向代理 + HTTPS（推荐）

```nginx
server {
    listen 443 ssl http2;
    server_name ai-read.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/ai-read.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ai-read.your-domain.com/privkey.pem;

    client_max_body_size 64m;   # PDF 上传可能较大

    location / {
        proxy_pass         http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # SSE 流式必需：禁用缓冲
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 600s;
    }
}

server {
    listen 80;
    server_name ai-read.your-domain.com;
    return 301 https://$host$request_uri;
}
```

证书用 [certbot](https://certbot.eff.org/) 一键申请：

```bash
certbot --nginx -d ai-read.your-domain.com
```

### 方案 B：子路径部署

如果想在已有域名下挂子路径（如 `https://your-domain.com/ai-read/`），需要：

1. 在 Nginx 的 `location /ai-read/` 块里 `rewrite ^/ai-read/(.*)$ /$1 break;` 再 `proxy_pass http://127.0.0.1:8000;`。
2. 静态资源引用路径已经是相对路径，无需改代码。

### 配套 `.env` 改动

不论哪种方案，部署后请把 `.env` 改成：

```env
ALLOWED_ORIGINS=https://ai-read.your-domain.com
ADMIN_TOKEN=<生成一段随机长字符串>
UVICORN_RELOAD=false
```

> 鉴权打开后，前端首次访问会弹窗让你输入 `ADMIN_TOKEN`，输入后存 localStorage，后续请求自动带 `Authorization: Bearer <token>`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AI_API_BASE_URL` | — | 主力模型 API 地址（OpenAI 兼容） |
| `AI_API_KEY` | — | 主力模型 API Key |
| `AI_MODEL_NAME` | — | 主力模型名（用于速览/总结/思维导图/实验） |
| `AI_API_BASE_URL_FAST` | — | 辅助模型 API 地址，留空回退到主力 |
| `AI_API_KEY_FAST` | — | 辅助模型 API Key，留空回退到主力 |
| `AI_MODEL_NAME_FAST` | — | 辅助模型名（用于翻译） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8000` | 监听端口 |
| `MAX_UPLOAD_SIZE_MB` | `50` | PDF 最大上传大小 |
| `UVICORN_RELOAD` | `false` | 热重载（开发用） |
| `ADMIN_TOKEN` | — | **鉴权令牌**，留空则不启用（详见"安全建议"） |
| `ALLOWED_ORIGINS` | `*` | CORS 允许来源，逗号分隔多个 |

## 安全建议

这个项目最初是按"自用工具"设计的，默认配置非常宽松。**只要部署到公网，请务必按下面几条加固**：

1. **设置 `ADMIN_TOKEN`**：留空时 `/api/upload`、`/api/paper/{id}` DELETE、`POST /api/config` 全部对外开放，任何人都能消耗你的 API 配额或改写 API 配置把请求劫持到自己服务器。配置 `ADMIN_TOKEN` 后这些敏感接口需要请求头 `Authorization: Bearer <ADMIN_TOKEN>`。
2. **收紧 `ALLOWED_ORIGINS`**：生产环境改成你自己的域名（如 `https://ai-read.your-domain.com`），不要用 `*`。
3. **HTTPS**：上 Nginx + Let's Encrypt，避免 token 和 API Key 在中间链路被嗅探。
4. **API Key 长度**：用 OpenAI 兼容服务时尽量用受限 Key（设置月度预算上限、IP 白名单等）。
5. **数据库与上传目录**：`data/` 和 `uploads/` 不要暴露到静态文件目录，本项目已经通过 API 路由控制访问。
6. **错误信息**：服务端日志会记录详细错误，但前端只显示通用提示，不会泄露上游 API URL。

## 项目结构

```
ai_read/
├── backend/
│   ├── main.py              # FastAPI 应用 + 路由 + 鉴权 + SQLite
│   ├── pdf_parser.py        # PDF 解析（PyMuPDF）
│   ├── ai_service.py        # AI API 封装（流式 + 重试）
│   └── prompts/
│       └── __init__.py      # 各功能 Prompt 模板
├── frontend/
│   ├── index.html           # 单页应用
│   ├── css/style.css        # 样式
│   └── js/
│       ├── app.js           # 主逻辑
│       └── marked.min.js    # Markdown 渲染
├── uploads/                 # 上传文件目录（运行时生成）
├── data/                    # SQLite 数据目录（运行时生成）
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── requirements.txt
├── .env.example
├── LICENSE
└── README.md
```

## API 一览

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET  | `/api/health` | 健康检查 | ❌ |
| GET  | `/api/papers` | 列出最近 50 篇论文 | ❌ |
| POST | `/api/upload` | 上传 PDF | ✅ |
| GET  | `/api/paper/{id}/meta` | 论文元数据 | ❌ |
| GET  | `/api/paper/{id}/text` | 论文文本（可按页） | ❌ |
| GET  | `/api/paper/{id}/sections` | 章节分段 | ❌ |
| GET  | `/api/paper/{id}/pdf` | 原始 PDF | ❌ |
| GET  | `/api/paper/{id}/results` | 已保存的 AI 结果 | ❌ |
| DELETE | `/api/paper/{id}` | 删除论文 | ✅ |
| POST | `/api/paper/{id}/quick-scan` | 速览（SSE） | ❌ |
| POST | `/api/paper/{id}/summary` | 深度总结（SSE） | ❌ |
| POST | `/api/paper/{id}/mindmap` | 思维导图（SSE） | ❌ |
| POST | `/api/paper/{id}/experiments` | 实验汇总（SSE） | ❌ |
| POST | `/api/paper/{id}/translate-snippet` | 划词翻译 | ❌ |
| POST | `/api/paper/{id}/translate-full` | 全文翻译（SSE） | ❌ |
| GET  | `/api/config` | 获取当前 API 配置（Key 脱敏） | ❌ |
| POST | `/api/config` | 更新 API 配置 | ✅ |
| POST | `/api/models` | 拉取指定 API 的模型列表 | ❌ |

> "鉴权"列的 ✅ 表示启用 `ADMIN_TOKEN` 时需要 `Authorization: Bearer <token>` 请求头。

## 未来规划

- [ ] **PDF 内嵌划词翻译**：用 PDF.js 替换浏览器原生 PDF 预览，监听选区事件，实现真正的"在 PDF 上划词即译"。
- [ ] **多论文对比**：同时打开 2-3 篇论文，并排对比同一指标。
- [ ] **引用图谱**：抽取论文引用关系，可视化文献网络。
- [ ] **本地知识库**：把已上传论文向量化，支持跨论文问答（RAG）。
- [ ] **用户系统**：多用户隔离 + 论文分组管理。
- [ ] **导出**：把 AI 结果导出为 Markdown / Notion / PDF。
- [ ] **Prompt 自定义**：Web UI 里编辑各功能 Prompt 模板。
- [ ] **移动端适配**：响应式布局优化。
- [ ] **更多 PDF 解析后端**：支持扫描件 OCR（如 OCRmyPDF / PaddleOCR）。
- [ ] **国际化**：英文 UI。

欢迎在 [Issues](https://github.com/yyyyyh649/ai_read/issues) 提需求或 PR。

## License

[MIT](LICENSE)
