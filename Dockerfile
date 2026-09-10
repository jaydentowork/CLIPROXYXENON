FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY public ./public
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_PATH=/data/dashboard.sqlite
EXPOSE 8787
VOLUME ["/data"]
CMD ["node", "src/server.js"]
