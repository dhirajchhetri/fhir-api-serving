FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run keys
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/main.js"]
