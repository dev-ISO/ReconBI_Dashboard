# Use a lightweight Node.js image.
FROM node:18.20.6-alpine3.20

# Set the working directory in the container.
WORKDIR /app

# Copy the package.json and package-lock.json files.
COPY package*.json ./

# Install dependencies.
RUN npm install

# Copy the rest of your application code.
COPY . .

# Run the development server.
CMD ["npm", "run", "dev"]
