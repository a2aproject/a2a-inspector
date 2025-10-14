# Stage 1: Build the frontend assets
FROM node:18-alpine AS frontend-builder
WORKDIR /app

# Copy package files and configuration needed for npm ci
COPY frontend/package*.json ./
COPY frontend/tsconfig.json ./
COPY frontend/src ./src

# Install dependencies (this will run prepare script which needs tsconfig.json and src/)
RUN npm ci

# Copy remaining files
COPY frontend/ ./

# Rebuild native dependencies like esbuild for the container's architecture (Alpine)
# in case host node_modules were copied over.
RUN npm rebuild esbuild

RUN npm run build

# Stage 2: Build the final application with the backend
FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Run as non-root user in /app
RUN useradd -ms /bin/sh app
USER app
WORKDIR /app

COPY uv.lock pyproject.toml /app/
# Install dependencies
RUN uv sync --frozen --no-install-project

# Copy the project into the image
COPY . /app

# Sync the project
RUN uv sync --frozen


RUN mkdir -p /app/frontend
COPY --from=frontend-builder /app/public /app/frontend/public


WORKDIR /app/backend

# Expose the port the backend server runs on
EXPOSE 8080

# The command to run the server. Because our WORKDIR is now /app/backend,
# we can simply refer to 'app:app' from the current directory.git 
CMD ["uv", "run", "--", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]