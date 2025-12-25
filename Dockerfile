# Use a smaller, Alpine-based Node.js image for a significantly smaller footprint
FROM node:18-alpine

# Install ffmpeg using Alpine's package manager (apk)
# The --no-cache flag prevents storing the package index, reducing image size
RUN apk update && apk add --no-cache ffmpeg

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install app dependencies
# This is included for good practice, even though this app has no npm dependencies yet.
RUN npm install

# Bundle app source
COPY . .

# Make port 3000 available to the world outside this container
EXPOSE 3000

# Define the command to run the app
CMD [ "node", "server.js" ]

