#!/usr/bin/env bash

#GOOGLE_API_KEY=your-key-here OPENROUTER_API_KEY=your-key-here uv run uvicorn app:app --reload
GOOGLE_API_KEY=AIzaSyA5uRCzxVjl861Ka-SSZ3Wwr5SdVFmjx60 OPENROUTER_API_KEY=your-key-here uv run python -m uvicorn app:app --host 0.0.0.0 --port 8000 --workers 4
