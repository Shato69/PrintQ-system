# Use Node 20 on Debian (needed for LibreOffice)
FROM node:20-bullseye

# Install LibreOffice headless
RUN apt-get update && \
    apt-get install -y libreoffice && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package.json & package-lock.json
COPY package*.json ./

# Install Node dependencies
RUN npm install --production

# Copy the rest of the project
COPY . .

# Expose port (Render will use $PORT)
ENV PORT=3000
EXPOSE $PORT

# Start the server
CMD ["node", "src/js/backend/service-api.js"]
