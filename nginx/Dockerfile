FROM node:20-alpine AS builder
WORKDIR /app
COPY front/package*.json ./
RUN npm install
COPY front/ .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
