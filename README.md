# A2A Protocol Inspector

The A2A Inspector is a web-based tool designed to help developers inspect, debug, and validate servers that implement the Google A2A (Agent-to-Agent) protocol. It provides a user-friendly interface to interact with an A2A agent, view communication, and ensure specification compliance.

The application is built with a FastAPI backend and a TypeScript frontend.

## Features

- **Connect to a local A2A Agent:** Specify the base URL of any agent server to connect (e.g., `http://localhost:5555`).
- **View Agent Card:** Automatically fetches and displays the agent's card.
- **Spec Compliance Checks:** Performs basic validation on the agent card to ensure it adheres to the A2A specification.
- **Live Chat:** A chat interface to send and receive messages with the connected agent.
- **Debug Console:** A slide-out console shows the raw JSON-RPC 2.0 messages sent and received between the inspector and the agent server.

## Prerequisites

- Python 3.10+
- [uv](https://github.com/astral-sh/uv)
- Node.js and npm

## Project Structure

This repository is organized into two main parts:

- `./backend/`: Contains the Python FastAPI server that handles WebSocket connections and communication with the A2A agent.
- `./frontend/`: Contains the TypeScript and CSS source files for the web interface.

## Setup and Running the Application

Follow these steps to get the A2A Inspector running on your local machine. The setup is a three-step process: install Python dependencies, install Node.js dependencies, and then run the two processes.

### 1. Clone the repository

```sh
git clone https://github.com/a2aproject/a2a-inspector.git
cd a2a-inspector
```

### 2. Install Dependencies

First, install the Python dependencies for the backend from the root directory. `uv sync` reads the `uv.lock` file and installs the exact versions of the packages into a virtual environment.

```sh
# Run from the root of the project
uv sync
```

Next, install the Node.js dependencies for the frontend.

```sh
# Navigate to the frontend directory
cd frontend

# Install npm packages
npm install

# Go back to the root directory
cd ..
```

### 3. Run the Application

You can run the A2A Inspector in two ways. Choose the option that best fits your workflow:

- Option 1 (Run Locally): Best for developers who are actively modifying the code. This method uses two separate terminal processes and provides live-reloading for both the frontend and backend.
- Option 2 (Run with Docker): Best for quickly running the application without managing local Python and Node.js environments. Docker encapsulates all dependencies into a single container.

#### Option 1: Run Locally 

This approach requires you to run two processes concurrently. You can either use the provided convenience script or run them separately in different terminals.

**Using the convenience script (recommended):**

```sh
# Make the script executable (first time only)
chmod +x run.sh

# Run both frontend and backend with a single command
./run.sh
```

This will start both the frontend build process and backend server, displaying their outputs with colored prefixes. Press `Ctrl+C` to stop both services.

**Or manually in separate terminals:**

Make sure you are in the root directory of the project (a2a-inspector) before starting.

**In your first terminal**, run the frontend development server. This will build the assets and automatically rebuild them when you make changes.

```sh
# Navigate to the frontend directory
cd frontend

# Build the frontend and watch for changes
npm run build -- --watch
```

**In a second terminal**, run the backend Python server.

```sh
# Navigate to the backend directory
cd backend

# Run the FastAPI server with live reload
uv run app.py
```

##### Access the Inspector

Once both processes are running, open your web browser and navigate to:
**[http://127.0.0.1:5001](http://127.0.0.1:5001)**

#### Option Two: Run with Docker

This approach builds the entire application into a single Docker image and runs it as a container. This is the simplest way to run the inspector if you have Docker installed and don't need to modify the code.

From the root directory of the project, run the following command. This will build the frontend, copy the results into the backend, and package everything into an image named a2a-inspector.

```sh
docker build -t a2a-inspector .
```

Once the image is built, run it as a container.

```sh
# It will run the container in detached mode (in the background)
docker run -d -p 8080:8080 a2a-inspector
```

##### Access the Inspector

The container is now running in the background. Open your web browser and navigate to:
**[http://127.0.0.1:8080](http://127.0.0.1:8080)**

### 4. Inspect your agents

- Try inputting a sample agent URL such as `https://sample-a2a-agent-908687846511.us-central1.run.app`
