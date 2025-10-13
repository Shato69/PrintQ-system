# ===============================
# PrintQ Fly.io Deployment
# ===============================

FROM node:20-slim

# Install LibreOffice
RUN apt-get update && apt-get install -y libreoffice && apt-get clean

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8080
ENV PORT=8080

CMD ["node", "service-api.js"]
