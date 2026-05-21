# ═══════════════════════════════════════════════════════════════
# Matt's Pokemon Center Bot — Production Dockerfile
# Based on Playwright's official image (Chromium pre-installed)
# ═══════════════════════════════════════════════════════════════

FROM mcr.microsoft.com/playwright:v1.52.0-noble

# Install PM2 globally
RUN npm install -g pm2

WORKDIR /app

# Copy package files and install deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY ecosystem.config.cjs ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# Create required directories
RUN mkdir -p logs screenshots tmp

# Set timezone
ENV TZ=America/New_York
ENV NODE_ENV=production

# PM2 in no-daemon mode keeps the container alive
CMD ["pm2-runtime", "ecosystem.config.cjs"]
