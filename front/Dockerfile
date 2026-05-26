FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# dist/ 결과물만 nginx 볼륨 경로로 복사하는 용도
FROM alpine:3.18
WORKDIR /dist
COPY --from=builder /app/dist .
