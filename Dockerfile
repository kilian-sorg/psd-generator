FROM node:20-slim

# Install canvas dependencies (needed by ag-psd for image data)
RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    pkg-config \
    python3 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
