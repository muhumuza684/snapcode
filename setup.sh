#!/usr/bin/env bash
# Sandbox IDE — one-command setup (Mac/Linux)
# Run this from the project root: ./setup.sh
set -e

echo "Checking Docker..."
if ! docker ps > /dev/null 2>&1; then
  echo "Docker isn't running. Start Docker first, then re-run this script."
  exit 1
fi

echo "Building sandbox-python image..."
docker build -t sandbox-python -f docker/python.Dockerfile docker/

echo "Building sandbox-node image..."
docker build -t sandbox-node -f docker/node.Dockerfile docker/

echo "Building sandbox-dart image..."
docker build -t sandbox-dart -f docker/dart.Dockerfile docker/

echo "Installing server dependencies..."
cd server && npm install && cd ..

echo ""
echo "Setup complete."
echo "Start the server with:  cd server && npm start"
echo "Then open:              http://localhost:4000"
