FROM node:22-bookworm-slim AS web-build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY apps ./apps
COPY packages ./packages
COPY assets ./assets
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM ghcr.io/astral-sh/uv:0.9.5 AS uv-bin

FROM python:3.10.19-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=7860 \
    MAP_CONTEXT_CACHE_DIR=/app/data/map-context \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    TF_NUM_INTRAOP_THREADS=2 \
    TF_NUM_INTEROP_THREADS=1 \
    OMP_NUM_THREADS=2 \
    MALLOC_ARENA_MAX=2 \
    PATH="/opt/venv/bin:${PATH}"
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=uv-bin /uv /uvx /bin/
COPY --from=web-build /usr/local/bin/node /usr/local/bin/node
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY rasa-bot /app/rasa-bot
# Use the evaluated archive; do not silently retrain a different model.
COPY deployment/assemble-model.py /app/deployment/assemble-model.py
COPY deployment/hf-private-storage.py /app/deployment/hf-private-storage.py
RUN python /app/deployment/assemble-model.py
COPY --from=web-build /workspace/apps/web/dist/public /usr/share/nginx/html
COPY --from=web-build /workspace/apps/api/dist /app/api
COPY --from=web-build /workspace/apps/api/data/map-context /app/data/map-context
COPY --from=web-build /workspace/apps/api/data/certified-stays.json /app/data/certified-stays.json
COPY deployment/nginx.conf /etc/nginx/nginx.conf
COPY deployment/start-huggingface.sh /app/start-huggingface.sh
COPY deployment/container-healthcheck.py /app/container-healthcheck.py
RUN chmod +x /app/start-huggingface.sh \
    && chown -R 1000:1000 /app /usr/share/nginx/html /var/lib/nginx /var/log/nginx /run
USER 1000
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["python", "/app/container-healthcheck.py"]
CMD ["/app/start-huggingface.sh"]