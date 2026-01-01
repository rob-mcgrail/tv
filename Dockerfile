FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including dev dependencies for nodemon)
RUN npm install

# Expose port
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
