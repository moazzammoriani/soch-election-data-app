#!/bin/env bash

#GOOGLE_API_KEY=AIzaSyCbV3eijZdFPSdQBlndejmRS-8HWnymaY4 uv run uvicorn app:app --reload
GOOGLE_API_KEY=AIzaSyCbV3eijZdFPSdQBlndejmRS-8HWnymaY4 uv run uvicorn app:app --host 0.0.0.0 --port 8000 --workers 4
