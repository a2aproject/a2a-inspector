#!/bin/bash

# Script to run A2A Inspector frontend and backend simultaneously
# Both processes will be monitored and killed when the script exits

# Colors for output
RED=$(tput setaf 1)
GREEN=$(tput setaf 2)
YELLOW=$(tput setaf 3)
BLUE=$(tput setaf 4)
NC=$(tput sgr0) # No Color / Reset

# Function to cleanup processes on exit
cleanup() {
    echo -e "\n${YELLOW}Shutting down A2A Inspector...${NC}"

    # Kill the frontend process if it exists
    if [ ! -z "$FRONTEND_PID" ] && kill -0 $FRONTEND_PID 2>/dev/null; then
        echo -e "${RED}Stopping frontend (PID: $FRONTEND_PID)...${NC}"
        kill -TERM $FRONTEND_PID 2>/dev/null
        wait $FRONTEND_PID 2>/dev/null
    fi

    # Kill the backend process if it exists
    if [ ! -z "$BACKEND_PID" ] && kill -0 $BACKEND_PID 2>/dev/null; then
        echo -e "${RED}Stopping backend (PID: $BACKEND_PID)...${NC}"
        kill -TERM $BACKEND_PID 2>/dev/null
        wait $BACKEND_PID 2>/dev/null
    fi

    # Clean up any remaining child processes
    jobs -p | xargs -r kill -TERM 2>/dev/null

    echo -e "${GREEN}A2A Inspector stopped.${NC}"
    exit 0
}

# Set up trap to call cleanup function on script exit
trap cleanup EXIT INT TERM

# Check if directories exist
if [ ! -d "./frontend" ]; then
    echo -e "${RED}Error: ./frontend directory not found!${NC}"
    exit 1
fi

if [ ! -d "./backend" ]; then
    echo -e "${RED}Error: ./backend directory not found!${NC}"
    exit 1
fi

echo -e "${GREEN}Starting A2A Inspector...${NC}"

# Start frontend build in watch mode
echo -e "${BLUE}Starting frontend build (watch mode)...${NC}"
cd ./frontend || exit
npm run build -- --watch 2>&1 | sed "s/^/\\x1b[36m[FRONTEND]\\x1b[0m /" &
FRONTEND_PID=$!
cd - > /dev/null || exit

# Give frontend a moment to start
sleep 2

# Start backend server
echo -e "${BLUE}Starting backend server...${NC}"
cd ./backend || exit
uv run app.py 2>&1 | sed "s/^/\\x1b[35m[BACKEND]\\x1b[0m /" &
BACKEND_PID=$!
cd - > /dev/null || exit

echo -e "${GREEN}A2A Inspector is running!${NC}"
echo -e "${YELLOW}Frontend PID: $FRONTEND_PID${NC}"
echo -e "${YELLOW}Backend PID: $BACKEND_PID${NC}"
echo -e "${YELLOW}Press Ctrl+C to stop both services${NC}"

# Monitor both processes
while true; do
    # Check if frontend is still running
    if ! kill -0 $FRONTEND_PID 2>/dev/null; then
        echo -e "${RED}Frontend process died unexpectedly!${NC}"
        cleanup
    fi

    # Check if backend is still running
    if ! kill -0 $BACKEND_PID 2>/dev/null; then
        echo -e "${RED}Backend process died unexpectedly!${NC}"
        cleanup
    fi

    # Sleep for a bit before checking again
    sleep 1
done
