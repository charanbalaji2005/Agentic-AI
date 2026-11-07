#!/bin/bash
set -e

# Port assigned dynamically by Render (defaults to 10000 or $PORT)
WEB_PORT="${PORT:-10000}"
INTERNAL_PORT=8000

echo "[STARTUP] Starting FastAPI backend on 127.0.0.1:${INTERNAL_PORT}..."
python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port ${INTERNAL_PORT} &
BACKEND_PID=$!

echo "[STARTUP] Locating Next.js standalone server..."
SERVER_DIR=""
if [ -f "frontend/server.js" ]; then
  SERVER_DIR="frontend"
elif [ -f "frontend/frontend/server.js" ]; then
  SERVER_DIR="frontend/frontend"
elif [ -f "server.js" ]; then
  SERVER_DIR="."
fi

echo "[STARTUP] Starting Next.js frontend from ${SERVER_DIR} on 0.0.0.0:${WEB_PORT}..."
cd "${SERVER_DIR}"
PORT="${WEB_PORT}" HOSTNAME="0.0.0.0" INTERNAL_BACKEND_URL="http://127.0.0.1:${INTERNAL_PORT}" node server.js &
FRONTEND_PID=$!

# Trap termination signals (INT and TERM) cleanly
trap "kill -TERM $BACKEND_PID $FRONTEND_PID 2>/dev/null || true" INT TERM

# Wait for either process to exit
wait -n $BACKEND_PID $FRONTEND_PID
EXIT_CODE=$?
echo "[SHUTDOWN] Process exited with code $EXIT_CODE, terminating container..."
kill -TERM $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
exit $EXIT_CODE
