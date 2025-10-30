.PHONY: install build clean dev help

PLUGIN_DIR = rplugin/node/claude-nvim

help:
	@echo "Available targets:"
	@echo "  make install    - Install npm dependencies"
	@echo "  make build      - Build the TypeScript code"
	@echo "  make clean      - Clean build artifacts"
	@echo "  make dev        - Run TypeScript compiler in watch mode"
	@echo "  make all        - Install dependencies and build (default)"

all: install build

install:
	@echo "Installing npm dependencies..."
	cd $(PLUGIN_DIR) && CI=1 npm install

build:
	@echo "Building TypeScript code..."
	cd $(PLUGIN_DIR) && npm run build

clean:
	@echo "Cleaning build artifacts..."
	cd $(PLUGIN_DIR) && npm run clean

dev:
	@echo "Starting TypeScript compiler in watch mode..."
	cd $(PLUGIN_DIR) && npm run dev
