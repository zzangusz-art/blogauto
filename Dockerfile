FROM node:20-slim

# better-sqlite3 네이티브 컴파일에 필요한 빌드 도구
RUN apt-get update && apt-get install -y \
    python3 make g++ \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 먼저 복사 (레이어 캐시 최적화)
COPY package.json package-lock.json* ./

RUN npm ci --only=production --ignore-scripts \
    && npm rebuild better-sqlite3

# 소스 복사
COPY . .

# 영구 데이터 디렉터리 (볼륨 마운트 경로)
RUN mkdir -p /data

ENV NODE_ENV=production \
    DB_PATH=/data/blog.db \
    PORT=4000

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/health', r => process.exit(r.statusCode===200?0:1))"

CMD ["node", "server.js"]
