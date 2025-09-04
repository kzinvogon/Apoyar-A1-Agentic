#!/bin/bash

echo "🚀 Starting A1 Support Dashboard Prototype..."
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed."
    echo "   Please install Node.js from https://nodejs.org/"
    exit 1
fi

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

echo "✅ Dependencies ready"
echo "🌐 Starting server..."
echo ""
echo "📱 Open your browser and go to: http://localhost:3000"
echo "🔧 Health check: http://localhost:3000/health"
echo ""
echo "💡 Press Ctrl+C to stop the server"
echo ""

# Start the server
npm start

