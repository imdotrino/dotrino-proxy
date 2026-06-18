#!/bin/bash

# Name for the screen session
SESSION_NAME="websocket-proxy-dev"

# Check if screen is installed
if ! command -v screen &> /dev/null; then
    echo "❌ 'screen' command not found. Please install it first."
    echo "   On Ubuntu/Debian: sudo apt-get install screen"
    echo "   On macOS: brew install screen"
    exit 1
fi

echo "🔍 Checking for existing screen session named '$SESSION_NAME'..."

# Check if the screen session exists
if screen -list | grep -q "\.$SESSION_NAME\s"; then
    echo "🛑 Found existing session. Killing it..."
    # Kill the existing session
    screen -S $SESSION_NAME -X quit
    # Wait a moment for the session to be fully terminated
    sleep 1
    echo "✅ Previous session terminated."
else
    echo "✅ No existing session found."
fi

echo "🚀 Starting new screen session '$SESSION_NAME'..."

# Start a new screen session in detached mode with just bash
screen -dmS $SESSION_NAME bash

# Give it a moment to start
sleep 1

# Inject the npm run dev command into the screen session
echo "💉 Injecting 'npm run dev' command into screen session..."
screen -S $SESSION_NAME -X stuff "npm run dev$(printf \\r)"

# Give it a moment to start the server
sleep 2

# Check if the session was created successfully
if screen -list | grep -q "\.$SESSION_NAME\s"; then
    echo "✅ Screen session '$SESSION_NAME' started successfully!"
    echo ""
    echo "📋 Useful commands:"
    echo "   To attach to the session:   screen -r $SESSION_NAME"
    echo "   To detach from the session: Press Ctrl+A then D"
    echo "   To list all sessions:       screen -list"
    echo "   To kill this session:       screen -S $SESSION_NAME -X quit"
else
    echo "❌ Failed to start screen session!"
    exit 1
fi

echo ""
echo "📊 To view the server logs, attach to the screen session with:"
echo "   screen -r $SESSION_NAME"
