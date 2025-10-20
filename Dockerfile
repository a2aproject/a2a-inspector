FROM node:18-alpine AS frontend-builder
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build the final application with a stable Python version
FROM python:3.12-slim
WORKDIR /app

# Install build tools needed for C/Rust extensions, just in case
RUN apt-get update && apt-get install -y build-essential libffi-dev

# Install uv, the package manager
RUN pip install uv

# --- FIX IS HERE ---
# First, COPY the dependency files from your local machine into the container's WORKDIR
COPY pyproject.toml uv.lock ./

# Second, NOW that the files exist in the container, run the sync command
RUN uv sync --python-preference only-system --no-cache

# Copy and install dependencies. This should now use pre-compiled wheels.
RUN uv pip install validators

# Copy the rest of the application
COPY backend/ ./backend/
RUN mkdir -p /app/frontend
COPY --from=frontend-builder /app/public /app/frontend/public

WORKDIR /app/backend

# Expose the port the backend server runs on
EXPOSE 8080

# The command to run the server
CMD ["uv", "run", "--", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
