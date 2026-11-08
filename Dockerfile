# ==============================================================================
# Single-Container Multi-Stage Dockerfile for Render Free Tier (512MB RAM)
# Runs BOTH FastAPI Backend + Next.js Frontend on a single Web Service instance
# ==============================================================================

# --- Stage 1: Build Next.js Standalone Frontend ---
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --legacy-peer-deps

COPY frontend/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- Stage 2: Unified Production Container ---
FROM python:3.11-slim
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=10000

# Install Node.js 20 and system tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg procps \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python backend dependencies (CPU-only PyTorch wheel to keep image and memory small)
COPY backend/requirements.txt ./backend/
RUN pip install --upgrade pip \
    && pip install torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install -r backend/requirements.txt

# Bake the embedding + reranker models into the image so startup doesn't download them
# on every deploy / cold start. Override HF_HUB_OFFLINE=0 in Render if you switch models.
ENV HF_HOME=/app/hf-cache \
    HF_HUB_DISABLE_TELEMETRY=1
RUN python -c "from huggingface_hub import snapshot_download as d; \
ig=['pytorch_model.bin','*.onnx','onnx/*','openvino/*','*.h5','*.msgpack','*.ot','tf_model*','flax_model*','rust_model*']; \
[d(m, ignore_patterns=ig) for m in ('BAAI/bge-small-en-v1.5','cross-encoder/ms-marco-MiniLM-L-6-v2')]"
ENV HF_HUB_OFFLINE=1

# Copy backend source
COPY backend/ ./backend/

# Copy built Next.js standalone application
COPY --from=frontend-builder /app/frontend/.next/standalone ./frontend/
COPY --from=frontend-builder /app/frontend/.next/static ./frontend/.next/static
COPY --from=frontend-builder /app/frontend/public ./frontend/public

# Copy start script
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

# Render dynamically sets $PORT (defaults to 10000)
EXPOSE 10000

CMD ["/bin/bash", "./start.sh"]
