# GPU image by default; build with --build-arg BASE=python:3.11-slim for CPU-only hosts.
ARG BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
FROM ${BASE}
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HF_HOME=/models
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/local/bin/python
# uv provides `uvx` for Python-based MCP servers (fetch, AWS); Node provides `npx` for JS ones.
RUN pip3 install --break-system-packages uv 2>/dev/null || pip3 install uv
WORKDIR /app
COPY requirements.txt .
RUN pip3 install --break-system-packages -r requirements.txt 2>/dev/null || pip3 install -r requirements.txt
COPY . .
RUN useradd -m rag && mkdir -p /app/data /models && chown -R rag /app /models
USER rag
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s CMD curl -fs http://localhost:8000/health || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
