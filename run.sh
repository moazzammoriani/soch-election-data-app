#!/bin/env bash

#OPENROUTER_API_KEY=your-key-here uv run uvicorn app:app --reload
OPENROUTER_API_KEY=your-key-here uv run uvicorn app:app --host 0.0.0.0 --port 8000 --workers 4
