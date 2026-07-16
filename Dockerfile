# ─── 构建阶段 ───
FROM python:3.11-slim AS builder

# PyMuPDF 需要的系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libmupdf-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ─── 运行阶段 ───
FROM python:3.11-slim

# 运行时只需要 PyMuPDF 的运行库
RUN apt-get update && apt-get install -y --no-install-recommends \
        libmupdf \
        && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 拷贝安装好的 Python 包
COPY --from=builder /install /usr/local

# 拷贝项目代码
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY .env.example ./

# 创建运行时目录
RUN mkdir -p /app/uploads /app/data

ENV HOST=0.0.0.0 \
    PORT=8000 \
    UVICORN_RELOAD=false \
    PYTHONUNBUFFERED=1

EXPOSE 8000

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).read()" || exit 1

WORKDIR /app/backend
CMD ["python", "main.py"]
