import json
import re
import uuid
import sqlite3
import time
import asyncio
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager

import cv2
import numpy as np
import fitz
from fastapi import FastAPI, UploadFile, HTTPException, Cookie, Response as FastAPIResponse, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, ConfigDict, create_model, TypeAdapter
import base64
import os
from openai import OpenAI, RateLimitError
from google import genai
from google.genai.errors import ClientError as GeminiClientError
from enum import Enum


def deskew_image(img: np.ndarray) -> tuple[np.ndarray, float]:
    """Deskew image using Hough line detection. Returns (deskewed_image, skew_angle)."""
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(edges, 1, np.pi/180, 100, minLineLength=100, maxLineGap=10)

    if lines is None:
        return img, 0.0

    angles = []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        if abs(angle) < 45:
            angles.append(angle)

    if not angles:
        return img, 0.0

    median_angle = np.median(angles)
    (h, w) = img.shape[:2]
    center = (w // 2, h // 2)
    M = cv2.getRotationMatrix2D(center, median_angle, 1.0)
    return cv2.warpAffine(img, M, (w, h), borderMode=cv2.BORDER_REPLICATE), median_angle


# --- Vote value schema (fixed) ---

class VoteType(str, Enum):
    regular = "regular"
    crossed = "crossed"
    crossed_and_corrected = "crossedAndCorrected"
    overwritten = "overwritten"
    illegible = "illegible"
    blank = "blank"


class VoteValue(BaseModel):
    type: VoteType
    value: Optional[int] = None


# --- Database setup ---

DB_PATH = Path("election_data.db")
UPLOADS_DIR = Path("uploads")

# Chart-level filter: stations with computed turnout strictly above this ratio
# are excluded from every chart (both per-station plots and aggregate totals).
# Anything above ~95% is almost always an OCR misread or bad registered-voter
# count rather than a real vote outcome, and lets them distort charts.
TURNOUT_CAP = 0.95


def init_db():
    UPLOADS_DIR.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    # Queue table for polling stations through the workflow
    conn.execute("""
        CREATE TABLE IF NOT EXISTS polling_station_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            name TEXT NOT NULL,
            pages TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            form_data TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Legacy table - keep for backwards compatibility
    conn.execute("""
        CREATE TABLE IF NOT EXISTS polling_stations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            pdf_name TEXT NOT NULL,
            page_numbers TEXT NOT NULL,
            form_data TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            pdf_name TEXT,
            pdf_path TEXT,
            page_count INTEGER DEFAULT 0,
            processed_pages TEXT DEFAULT '[]',
            schema_fields TEXT DEFAULT '[]',
            candidate_1_name TEXT,
            candidate_1_row INTEGER,
            candidate_2_name TEXT,
            candidate_2_row INTEGER,
            pending_pages TEXT,
            pending_form_data TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Migration: add pending columns if they don't exist
    try:
        conn.execute("ALTER TABLE sessions ADD COLUMN pending_pages TEXT")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE sessions ADD COLUMN pending_form_data TEXT")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE sessions ADD COLUMN province TEXT")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE sessions ADD COLUMN seat_type TEXT")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE sessions ADD COLUMN comparison_source TEXT")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE polling_station_queue ADD COLUMN source TEXT DEFAULT 'ecp'")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE sessions ADD COLUMN page_labels TEXT")
    except sqlite3.OperationalError:
        pass
    conn.commit()
    conn.close()


# --- Session helpers ---

def get_session(session_id: str) -> Optional[dict]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    conn.close()
    if row:
        return {
            "id": row["id"],
            "pdf_name": row["pdf_name"],
            "pdf_path": row["pdf_path"],
            "page_count": row["page_count"],
            "processed_pages": json.loads(row["processed_pages"]),
            "schema_fields": json.loads(row["schema_fields"]),
            "candidate_1": {"name": row["candidate_1_name"], "row": row["candidate_1_row"]} if row["candidate_1_name"] else None,
            "candidate_2": {"name": row["candidate_2_name"], "row": row["candidate_2_row"]} if row["candidate_2_name"] else None,
            "pending_pages": json.loads(row["pending_pages"]) if row["pending_pages"] else None,
            "pending_form_data": json.loads(row["pending_form_data"]) if row["pending_form_data"] else None,
            "province": row["province"],
            "seat_type": row["seat_type"],
            "comparison_source": row["comparison_source"],
            "page_labels": json.loads(row["page_labels"]) if row["page_labels"] else None,
        }
    return None


def create_session() -> str:
    session_id = str(uuid.uuid4())
    conn = sqlite3.connect(DB_PATH)
    conn.execute("INSERT INTO sessions (id) VALUES (?)", (session_id,))
    conn.commit()
    conn.close()
    return session_id


def update_session(session_id: str, **kwargs):
    conn = sqlite3.connect(DB_PATH)
    updates = []
    values = []
    for key, value in kwargs.items():
        if key in ("processed_pages", "schema_fields", "pending_pages", "pending_form_data", "page_labels"):
            value = json.dumps(value) if value is not None else None
        updates.append(f"{key} = ?")
        values.append(value)
    updates.append("updated_at = CURRENT_TIMESTAMP")
    values.append(session_id)
    conn.execute(f"UPDATE sessions SET {', '.join(updates)} WHERE id = ?", values)
    conn.commit()
    conn.close()


def delete_session(session_id: str):
    session = get_session(session_id)
    if session and session["pdf_path"]:
        pdf_path = Path(session["pdf_path"])
        if pdf_path.exists():
            pdf_path.unlink()
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    conn.commit()
    conn.close()


# --- Rate limiter for Gemini API ---

class RateLimiter:
    def __init__(self, max_per_second: float = 10):
        self.min_interval = 1.0 / max_per_second
        self.last_request = 0.0
        self.lock = asyncio.Lock()

    async def acquire(self):
        async with self.lock:
            now = time.monotonic()
            wait_time = self.last_request + self.min_interval - now
            if wait_time > 0:
                await asyncio.sleep(wait_time)
            self.last_request = time.monotonic()


# Global rate limiter: 15 req/sec = 900 RPM (safe margin under 1k RPM limit)
gemini_rate_limiter = RateLimiter(max_per_second=15)


def make_strict_schema(pydantic_model) -> dict:
    """Convert a Pydantic model's JSON schema to OpenAI strict-mode compatible format.

    Strict mode requires: all properties in 'required', 'additionalProperties: false'
    on every object, and no 'anyOf' for nullable types (use 'type': ['integer', 'null'] instead).
    """
    schema = pydantic_model.model_json_schema()

    def transform(obj):
        if not isinstance(obj, dict):
            return obj

        # Resolve $ref
        if "$ref" in obj:
            ref_path = obj["$ref"].replace("#/$defs/", "")
            if "$defs" in schema and ref_path in schema["$defs"]:
                resolved = schema["$defs"][ref_path].copy()
                return transform(resolved)
            return obj

        # Convert anyOf [{"type": "X"}, {"type": "null"}] to {"type": "X", "nullable": true}
        # Gemini's native schema format uses "nullable" rather than anyOf or type arrays
        if "anyOf" in obj:
            non_null_types = []
            has_null = False
            for option in obj["anyOf"]:
                if option.get("type") == "null":
                    has_null = True
                elif "$ref" in option:
                    resolved = transform(option)
                    result = {k: v for k, v in obj.items() if k != "anyOf"}
                    result.update(resolved)
                    if has_null:
                        result["nullable"] = True
                    return transform(result)
                else:
                    non_null_types.append(option)
            if non_null_types:
                result = {k: v for k, v in obj.items() if k != "anyOf"}
                result.update(non_null_types[0])
                if has_null:
                    result["nullable"] = True
                return transform(result)

        # For object types: enforce additionalProperties and required
        if obj.get("type") == "object" and "properties" in obj:
            obj["additionalProperties"] = False
            obj["required"] = list(obj["properties"].keys())
            obj["properties"] = {k: transform(v) for k, v in obj["properties"].items()}

        # Recurse into all dict values
        for key in list(obj.keys()):
            if isinstance(obj[key], dict):
                obj[key] = transform(obj[key])
            elif isinstance(obj[key], list):
                obj[key] = [transform(item) if isinstance(item, dict) else item for item in obj[key]]

        return obj

    schema = transform(schema)
    # Remove top-level $defs since we've inlined everything
    schema.pop("$defs", None)
    # Remove title fields (not needed for strict mode)
    def strip_titles(obj):
        if isinstance(obj, dict):
            obj.pop("title", None)
            obj.pop("default", None)
            for v in obj.values():
                strip_titles(v)
        elif isinstance(obj, list):
            for item in obj:
                strip_titles(item)
    strip_titles(schema)
    schema["additionalProperties"] = False
    schema["required"] = list(schema.get("properties", {}).keys())
    return schema


class _GeminiResponse:
    """Wraps Gemini SDK response to match OpenAI response shape."""
    def __init__(self, text):
        self.choices = [type('C', (), {'message': type('M', (), {'content': text})()})]


_client_cache = {}

def get_client(provider):
    if provider not in _client_cache:
        if provider == "gemini":
            _client_cache[provider] = genai.Client(api_key=os.environ.get("GOOGLE_API_KEY", ""))
        else:
            _client_cache[provider] = OpenAI(
                base_url="https://openrouter.ai/api/v1",
                api_key=os.environ.get("OPENROUTER_API_KEY", ""),
            )
    return _client_cache[provider]


async def call_gemini_with_retry(content_parts, response_schema, schema_name: str = "FormData",
                                  provider: str = "openrouter", model: str = "google/gemini-3-flash-preview",
                                  max_retries: int = 3):
    """Call Gemini API with retry logic for rate limit errors. Supports both direct Gemini and OpenRouter."""
    client = get_client(provider)

    for attempt in range(max_retries):
        await gemini_rate_limiter.acquire()
        try:
            if provider == "gemini":
                # Convert OpenAI-format content_parts to genai format
                contents = []
                for part in content_parts:
                    if part["type"] == "text":
                        contents.append(part["text"])
                    elif part["type"] == "image_url":
                        b64_data = part["image_url"]["url"].split(",", 1)[1]
                        contents.append(genai.types.Part.from_bytes(
                            data=base64.b64decode(b64_data), mime_type="image/png"))
                response = await asyncio.to_thread(
                    client.models.generate_content,
                    model=model,
                    contents=contents,
                    config=genai.types.GenerateContentConfig(
                        response_mime_type="application/json",
                        response_schema=response_schema,
                        thinking_config=genai.types.ThinkingConfig(thinking_level="low"),
                    ),
                )
                return _GeminiResponse(response.text)
            else:
                strict_schema = make_strict_schema(response_schema)
                response = await asyncio.to_thread(
                    client.chat.completions.create,
                    model=model,
                    messages=[{"role": "user", "content": content_parts}],
                    response_format={
                        "type": "json_schema",
                        "json_schema": {
                            "name": schema_name,
                            "strict": True,
                            "schema": strict_schema,
                        },
                    },
                )
                return response
        except RateLimitError:
            if attempt < max_retries - 1:
                await asyncio.sleep(30 * (2 ** attempt))
            else:
                raise
        except GeminiClientError as e:
            if e.status_code == 429 and attempt < max_retries - 1:
                await asyncio.sleep(30 * (2 ** attempt))
            else:
                raise


# --- App setup ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(lifespan=lifespan)


# --- API Models ---

class CandidateInfo(BaseModel):
    name: str
    row: int


class SchemaDefinition(BaseModel):
    candidate_1: CandidateInfo
    candidate_2: CandidateInfo
    province: Optional[str] = None
    seat_type: Optional[str] = None


class ProcessRequest(BaseModel):
    pages: list[int]
    provider: str = "openrouter"
    model: str = "google/gemini-3-flash-preview"


class ApproveRequest(BaseModel):
    pages: list[int]
    form_data: dict


class CreatePollingStationRequest(BaseModel):
    pages: list[int]


class BatchCreatePollingStationsRequest(BaseModel):
    page_groups: list[list[int]]


class AIProviderRequest(BaseModel):
    provider: str = "openrouter"
    model: str = "google/gemini-3-flash-preview"
    ids: Optional[list[int]] = None

class BulkActionRequest(BaseModel):
    ids: Optional[list[int]] = None


class _PollingStationRefModel(BaseModel):
    seat_name: str
    polling_station_num: int
    name: Optional[str] = None
    block_codes: list[str]
    total_reg_voters: Optional[int] = None


class _MatchRecordModel(BaseModel):
    nat: _PollingStationRefModel
    prov: Optional[_PollingStationRefModel] = None
    matching_block_codes: list[str]
    total_reg_voters_equal: Optional[bool] = None
    total_reg_voters_delta: Optional[int] = None
    name_score: Optional[float] = None


_MATCH_RECORDS_ADAPTER = TypeAdapter(list[_MatchRecordModel])


class PageGuesses(BaseModel):
    pages: list[int]


class DetectPageLabelsRequest(BaseModel):
    max_pages: int
    max_rows: int = 0
    start_page: int = 0
    end_page: Optional[int] = None
    provider: str = "openrouter"
    model: str = "google/gemini-3-flash-preview"


class SmartCreateRequest(BaseModel):
    max_pages: int
    start_page: int = 0
    end_page: Optional[int] = None


class ApprovePollingStationRequest(BaseModel):
    form_data: dict


class RenamePollingStationRequest(BaseModel):
    name: str


class RenumberRequest(BaseModel):
    from_number: int
    offset: int


PROVINCES = ["Punjab", "Sindh", "KPK", "Balochistan"]


def normalize_seat_name(pdf_name: str) -> Optional[str]:
    """Normalize a pdf_name like 'NA-239.pdf' to canonical seat_name like 'na_239'."""
    if not pdf_name:
        return None
    m = re.search(r'(na|pp|ps)[-_ ]*(\d+)', pdf_name, re.IGNORECASE)
    if not m:
        return None
    return f"{m.group(1).lower()}_{int(m.group(2))}"


# --- Endpoints ---

@app.get("/api/provinces")
async def get_provinces():
    return {"provinces": PROVINCES}


def get_session_step(session: dict) -> str:
    """Determine the current step for a session."""
    if not session["pdf_name"]:
        return "upload"
    if not session["schema_fields"]:
        return "schema"
    return "process"


@app.get("/api/sessions")
async def list_sessions():
    """List all sessions for dashboard."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM sessions ORDER BY updated_at DESC"
    ).fetchall()

    # Build session_id -> normalized seat_name mapping
    seat_names = {}
    for row in rows:
        seat_name = normalize_seat_name(row["pdf_name"])
        if seat_name:
            seat_names[row["id"]] = seat_name

    # Preload set of all matched canonical (seat_name, station_num) pairs
    matched_pairs = set()
    if seat_names:
        matched_rows = conn.execute("""
            SELECT pss.seat_name, pss.polling_station_num
            FROM polling_scheme_station pss
            JOIN polling_scheme_match psm ON psm.nat_station_id = pss.id
        """).fetchall()
        matched_pairs = {(r["seat_name"], r["polling_station_num"]) for r in matched_rows}

    # Get all ECP queue rows to count matches per session
    queue_rows = conn.execute("""
        SELECT session_id, name FROM polling_station_queue
        WHERE source = 'ecp' AND name LIKE 'Polling Station %'
    """).fetchall()
    conn.close()

    station_num_re = re.compile(r'^Polling Station\s+(\d+)$')
    match_counts = {}
    for qr in queue_rows:
        sid = qr["session_id"]
        seat_name = seat_names.get(sid)
        if not seat_name:
            continue
        m = station_num_re.match(qr["name"])
        if not m:
            continue
        if (seat_name, int(m.group(1))) in matched_pairs:
            match_counts[sid] = match_counts.get(sid, 0) + 1

    sessions = []
    for row in rows:
        session = {
            "id": row["id"],
            "pdf_name": row["pdf_name"],
            "page_count": row["page_count"],
            "processed_pages": json.loads(row["processed_pages"]),
            "candidate_1_name": row["candidate_1_name"],
            "candidate_2_name": row["candidate_2_name"],
            "province": row["province"],
            "seat_type": row["seat_type"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "matched_count": match_counts.get(row["id"], 0),
            "comparison_source": row["comparison_source"],
        }
        session["step"] = get_session_step({
            "pdf_name": session["pdf_name"],
            "schema_fields": json.loads(row["schema_fields"]),
            "page_count": session["page_count"],
            "processed_pages": session["processed_pages"],
        })
        sessions.append(session)

    return {"sessions": sessions}


@app.post("/api/sessions/{target_session_id}/switch")
async def switch_session(target_session_id: str, response: FastAPIResponse):
    """Switch to a different session."""
    session = get_session(target_session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    response.set_cookie(key="session_id", value=target_session_id, httponly=True, samesite="lax")
    return {"status": "ok", "session_id": target_session_id}


@app.delete("/api/sessions/{target_session_id}")
async def delete_session_endpoint(target_session_id: str, response: FastAPIResponse, session_id: Optional[str] = Cookie(default=None)):
    """Delete a session."""
    session = get_session(target_session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    delete_session(target_session_id)

    # If deleting current session, clear the cookie
    if session_id == target_session_id:
        response.delete_cookie(key="session_id")

    return {"status": "ok"}


@app.patch("/api/sessions/{target_session_id}/rename")
async def rename_session(target_session_id: str, req: RenamePollingStationRequest):
    """Rename a session (updates pdf_name, which drives seat matching)."""
    session = get_session(target_session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    new_name = req.name.strip()
    if not new_name:
        raise HTTPException(400, "Name cannot be empty")

    update_session(target_session_id, pdf_name=new_name)
    return {"status": "ok", "pdf_name": new_name}


@app.get("/api/sessions/{target_session_id}/chart-data")
async def get_chart_data(target_session_id: str, source: str = "ecp"):
    """Get aggregated vote data for charts."""
    session = get_session(target_session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    if not session["candidate_1"] or not session["candidate_2"]:
        raise HTTPException(400, "No candidates defined")

    c1_name = session["candidate_1"]["name"]
    c2_name = session["candidate_2"]["name"]
    c1_field = c1_name.lower().replace(" ", "_") + "_col3"
    c2_field = c2_name.lower().replace(" ", "_") + "_col3"

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT name, form_data FROM polling_station_queue WHERE session_id = ? AND status = 'approved' AND source = ? ORDER BY id ASC",
        (target_session_id, source)
    ).fetchall()

    # Load trusted registered-voter counts from the polling scheme for this
    # seat, keyed by polling_station_num. Used as an override over the OCR'd
    # form_data value whenever the scheme has a number for that station.
    scheme_registered = _load_polling_scheme_registered(
        conn, normalize_seat_name(session.get("pdf_name"))
    )
    conn.close()

    station_num_re = re.compile(r'^Polling Station\s+(\d+)$')

    c1_total = 0
    c2_total = 0
    per_station = []
    for row in rows:
        form_data = json.loads(row["form_data"]) if row["form_data"] else {}
        c1_val = form_data.get(c1_field, {}).get("value") or 0
        c2_val = form_data.get(c2_field, {}).get("value") or 0

        # Drop stations where our two tracked candidates are tied (including
        # the 0-0 "neither got votes" case). We can't determine a winner here
        # so the station is excluded from every chart and from aggregate totals.
        if c1_val == c2_val:
            continue

        # Use the larger of OCR'd and polling-scheme registered voters. Guards
        # against OCR digit misreads that would otherwise produce >100% turnout.
        scheme_reg = 0
        m = station_num_re.match(row["name"])
        if m:
            scheme_reg = scheme_registered.get(int(m.group(1))) or 0
        ocr_reg = form_data.get("total_registered_voters", {}).get("value") or 0
        registered = max(ocr_reg, scheme_reg)

        votes_cast = _votes_cast(form_data) or 0
        turnout = (votes_cast / registered) if registered else None

        # Exclude bogus-turnout stations from every chart (per-station and
        # aggregate). Stations with unknown turnout (no registered voters at
        # all) still pass through, since we can't judge them.
        if turnout is not None and turnout > TURNOUT_CAP:
            continue

        c1_total += c1_val
        c2_total += c2_val
        per_station.append({"name": row["name"], "votes": [c1_val, c2_val], "turnout": turnout, "registered": registered})

    return {
        "pdf_name": session["pdf_name"],
        "candidates": [c1_name, c2_name],
        "totals": [c1_total, c2_total],
        "per_station": per_station,
        "source": source,
        "comparison_source": session["comparison_source"],
        "seat_type": session.get("seat_type"),
    }


def _votes_cast(form_data: dict) -> Optional[int]:
    """Return votes cast for a station as max(row_a, row_b, row_c, row_d).

    Any of the four rows can represent votes cast depending on how the form
    was filled out; taking the max protects against OCR picking up a
    partially-filled row and under-counting.
    """
    values = [
        form_data.get("row_a", {}).get("value") or 0,
        form_data.get("row_b", {}).get("value") or 0,
        form_data.get("row_c", {}).get("value") or 0,
        form_data.get("row_d", {}).get("value") or 0,
    ]
    votes_cast = max(values)
    return votes_cast if votes_cast else None


def _compute_turnout(form_data: dict, scheme_registered: Optional[int] = None) -> Optional[float]:
    """Compute turnout ratio from form data.

    Uses ``max(ocr_total_registered_voters, scheme_registered)`` as the
    denominator — this way the larger of the two trusted sources wins, which
    avoids bogus >100% turnouts when OCR misreads a digit low on a single form.
    """
    votes_cast = _votes_cast(form_data) or 0
    ocr_reg = form_data.get("total_registered_voters", {}).get("value") or 0
    registered = max(ocr_reg or 0, scheme_registered or 0)
    return (votes_cast / registered) if registered else None


def _load_polling_scheme_registered(conn, seat_name: Optional[str]) -> dict:
    """Return {polling_station_num: total_reg_voters} for a given seat.

    Only includes stations where the polling scheme has a non-null positive
    total_reg_voters. Empty dict if no scheme data exists for this seat or if
    the polling_scheme_station table hasn't been created yet.
    """
    if not seat_name:
        return {}
    try:
        rows = conn.execute(
            "SELECT polling_station_num, total_reg_voters FROM polling_scheme_station "
            "WHERE seat_name = ? AND total_reg_voters IS NOT NULL AND total_reg_voters > 0",
            (seat_name,),
        ).fetchall()
    except sqlite3.OperationalError:
        # Table doesn't exist — no polling scheme has been imported yet.
        return {}
    return {r["polling_station_num"]: r["total_reg_voters"] for r in rows}


@app.get("/api/sessions/{target_session_id}/na-pa-turnout-diff")
async def get_na_pa_turnout_diff(target_session_id: str):
    """Get turnout difference data between matched NA and PA polling stations."""
    session = get_session(target_session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    seat_name = normalize_seat_name(session.get("pdf_name"))
    if not seat_name or not seat_name.startswith("na_"):
        return {"na_seat": seat_name, "pa_seats": [], "candidates": [], "stations": []}

    # Load candidate field names for winner determination (mirrors get_chart_data)
    if session.get("candidate_1") and session.get("candidate_2"):
        c1_name = session["candidate_1"]["name"]
        c2_name = session["candidate_2"]["name"]
        c1_field = c1_name.lower().replace(" ", "_") + "_col3"
        c2_field = c2_name.lower().replace(" ", "_") + "_col3"
    else:
        c1_name = c2_name = None
        c1_field = c2_field = None

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Get all (na_num -> pa_seat, pa_num) mappings, plus polling-scheme
    # registered-voter totals for each side so we can prefer them over the
    # OCR'd form_data values when computing turnout %.
    match_rows = conn.execute("""
        SELECT nat.polling_station_num AS na_num,
               prov.seat_name AS pa_seat, prov.polling_station_num AS pa_num,
               nat.total_reg_voters AS na_ps_reg,
               prov.total_reg_voters AS pa_ps_reg
        FROM polling_scheme_match psm
        JOIN polling_scheme_station nat ON nat.id = psm.nat_station_id
        JOIN polling_scheme_station prov ON prov.id = psm.prov_station_id
        WHERE nat.seat_name = ?
    """, (seat_name,)).fetchall()

    if not match_rows:
        conn.close()
        return {"na_seat": seat_name, "pa_seats": [], "stations": []}

    pa_seat_names = {r["pa_seat"] for r in match_rows}

    # Find session IDs for PA seats
    prov_sessions = conn.execute(
        "SELECT id, pdf_name FROM sessions WHERE seat_type = 'Provincial'"
    ).fetchall()
    pa_seat_to_session = {}
    for ps in prov_sessions:
        sn = normalize_seat_name(ps["pdf_name"])
        if sn in pa_seat_names:
            pa_seat_to_session[sn] = ps["id"]

    # Fetch NA approved stations
    na_queue = conn.execute(
        "SELECT name, form_data FROM polling_station_queue "
        "WHERE session_id = ? AND status = 'approved' AND source = 'ecp'",
        (target_session_id,)
    ).fetchall()

    station_num_re = re.compile(r'^Polling Station\s+(\d+)$')
    na_data = {}
    for row in na_queue:
        m = station_num_re.match(row["name"])
        if m:
            na_data[int(m.group(1))] = json.loads(row["form_data"]) if row["form_data"] else {}

    # Fetch PA approved stations for all relevant sessions in one query
    pa_session_ids = list(pa_seat_to_session.values())
    pa_data = {}  # (pa_seat_name, pa_num) -> form_data
    if pa_session_ids:
        placeholders = ",".join("?" * len(pa_session_ids))
        pa_queue = conn.execute(
            f"SELECT session_id, name, form_data FROM polling_station_queue "
            f"WHERE session_id IN ({placeholders}) AND status = 'approved' AND source = 'ecp'",
            pa_session_ids
        ).fetchall()

        # Reverse map: session_id -> seat_name
        session_to_seat = {sid: sn for sn, sid in pa_seat_to_session.items()}
        for row in pa_queue:
            m = station_num_re.match(row["name"])
            if m:
                sn = session_to_seat.get(row["session_id"])
                if sn:
                    pa_data[(sn, int(m.group(1)))] = json.loads(row["form_data"]) if row["form_data"] else {}

    conn.close()

    # Build result
    stations = []
    for mr in match_rows:
        na_num = mr["na_num"]
        pa_seat = mr["pa_seat"]
        pa_num = mr["pa_num"]

        na_fd = na_data.get(na_num)
        pa_fd = pa_data.get((pa_seat, pa_num))
        if na_fd is None or pa_fd is None:
            continue

        na_votes = _votes_cast(na_fd)
        pa_votes = _votes_cast(pa_fd)
        if na_votes is None or pa_votes is None:
            continue

        na_turnout_pct = _compute_turnout(na_fd, mr["na_ps_reg"])
        pa_turnout_pct = _compute_turnout(pa_fd, mr["pa_ps_reg"])

        # Exclude pairs where either side's turnout is above the cap — these
        # are almost always OCR digit misreads rather than real outcomes.
        if (na_turnout_pct is not None and na_turnout_pct > TURNOUT_CAP) or \
           (pa_turnout_pct is not None and pa_turnout_pct > TURNOUT_CAP):
            continue

        # Winner index: 0 = c1, 1 = c2. Ties (including 0-0) and sessions
        # without a candidate schema are dropped from the chart entirely.
        if not c1_field or not c2_field:
            continue
        c1_val = na_fd.get(c1_field, {}).get("value") or 0
        c2_val = na_fd.get(c2_field, {}).get("value") or 0
        if c1_val > c2_val:
            winner_idx = 0
        elif c2_val > c1_val:
            winner_idx = 1
        else:
            continue

        stations.append({
            "na_station_num": na_num,
            "pa_seat_name": pa_seat,
            "pa_station_num": pa_num,
            "na_turnout": na_votes,
            "pa_turnout": pa_votes,
            "diff": abs(na_votes - pa_votes),
            "na_turnout_pct": na_turnout_pct,
            "pa_turnout_pct": pa_turnout_pct,
            "winner_idx": winner_idx,
        })

    stations.sort(key=lambda s: s["na_station_num"])

    return {
        "na_seat": seat_name,
        "pa_seats": sorted(pa_seat_names),
        "candidates": [c1_name, c2_name] if c1_name and c2_name else [],
        "stations": stations,
    }


@app.get("/api/polling-scheme/export")
async def export_polling_scheme():
    """Export the current polling scheme mapping as JSON.

    Output is the exact format accepted by /api/polling-scheme/import: a JSON
    array of MatchRecord objects, one per NA station. Matched NA stations
    include their paired PA station under `prov`; unmatched NA stations have
    `prov: null`.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    try:
        station_rows = conn.execute(
            "SELECT id, seat_name, seat_type, polling_station_num, station_name, total_reg_voters "
            "FROM polling_scheme_station"
        ).fetchall()
    except sqlite3.OperationalError:
        conn.close()
        raise HTTPException(404, "Polling scheme has not been imported yet")

    block_rows = conn.execute(
        "SELECT station_id, block_code FROM polling_scheme_station_block_code"
    ).fetchall()
    match_rows = conn.execute(
        "SELECT nat_station_id, prov_station_id, matching_block_codes, "
        "total_reg_voters_equal, total_reg_voters_delta, name_score "
        "FROM polling_scheme_match"
    ).fetchall()
    conn.close()

    blocks_by_station: dict[str, list[str]] = {}
    for r in block_rows:
        blocks_by_station.setdefault(r["station_id"], []).append(r["block_code"])

    station_ref_by_id: dict[str, dict] = {}
    for s in station_rows:
        station_ref_by_id[s["id"]] = {
            "seat_name": s["seat_name"],
            "polling_station_num": s["polling_station_num"],
            "name": s["station_name"],
            "block_codes": sorted(blocks_by_station.get(s["id"], [])),
            "total_reg_voters": s["total_reg_voters"],
        }

    matches_by_nat = {r["nat_station_id"]: r for r in match_rows}

    records = []
    for s in station_rows:
        if s["seat_type"] != "National":
            continue
        nat_ref = station_ref_by_id[s["id"]]
        match = matches_by_nat.get(s["id"])
        if match is not None:
            prov_ref = station_ref_by_id.get(match["prov_station_id"])
            equal = match["total_reg_voters_equal"]
            records.append({
                "nat": nat_ref,
                "prov": prov_ref,
                "matching_block_codes": json.loads(match["matching_block_codes"]),
                "total_reg_voters_equal": bool(equal) if equal is not None else None,
                "total_reg_voters_delta": match["total_reg_voters_delta"],
                "name_score": match["name_score"],
            })
        else:
            records.append({
                "nat": nat_ref,
                "prov": None,
                "matching_block_codes": [],
                "total_reg_voters_equal": None,
                "total_reg_voters_delta": None,
                "name_score": None,
            })

    records.sort(key=lambda r: (r["nat"]["seat_name"], r["nat"]["polling_station_num"]))

    payload = json.dumps(records, indent=2, ensure_ascii=False)
    return FastAPIResponse(
        content=payload,
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="polling_scheme.json"'},
    )


@app.post("/api/polling-scheme/import")
async def import_polling_scheme(file: UploadFile):
    """Replace all polling scheme mapping data with the contents of an uploaded JSON file.

    Accepts the exact output format of polling_scheme/map_polling_schemes.py
    (a JSON array of MatchRecord objects). Wipes polling_scheme_match,
    polling_scheme_station_block_code, and polling_scheme_station, then
    repopulates them from the upload.
    """
    if not file.filename or not file.filename.lower().endswith(".json"):
        raise HTTPException(400, "File must be a .json file")

    content = await file.read()
    try:
        records = _MATCH_RECORDS_ADAPTER.validate_json(content)
    except Exception as e:
        raise HTTPException(400, f"Invalid polling scheme JSON: {e}")

    # Collect station refs (deduped by station id) and matched pairs
    station_payloads: dict[str, _PollingStationRefModel] = {}
    matched_pairs: list[tuple[_MatchRecordModel, str, str]] = []
    for rec in records:
        nat_id = f"{rec.nat.seat_name}:{rec.nat.polling_station_num}"
        station_payloads[nat_id] = rec.nat
        if rec.prov is not None:
            prov_id = f"{rec.prov.seat_name}:{rec.prov.polling_station_num}"
            station_payloads[prov_id] = rec.prov
            matched_pairs.append((rec, nat_id, prov_id))

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")

    # Ensure tables exist (fresh installs won't have them until map_polling_schemes.py runs).
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS polling_scheme_station (
            id TEXT PRIMARY KEY,
            seat_name TEXT NOT NULL,
            seat_type TEXT NOT NULL CHECK (seat_type IN ('National', 'Provincial')),
            polling_station_num INTEGER NOT NULL,
            station_name TEXT,
            total_reg_voters INTEGER,
            UNIQUE (seat_name, polling_station_num)
        );
        CREATE TABLE IF NOT EXISTS polling_scheme_station_block_code (
            station_id TEXT NOT NULL,
            block_code TEXT NOT NULL,
            PRIMARY KEY (station_id, block_code),
            FOREIGN KEY (station_id) REFERENCES polling_scheme_station(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS polling_scheme_match (
            nat_station_id TEXT PRIMARY KEY,
            prov_station_id TEXT NOT NULL UNIQUE,
            matching_block_codes TEXT NOT NULL,
            total_reg_voters_equal INTEGER,
            total_reg_voters_delta INTEGER,
            name_score REAL,
            FOREIGN KEY (nat_station_id) REFERENCES polling_scheme_station(id) ON DELETE CASCADE,
            FOREIGN KEY (prov_station_id) REFERENCES polling_scheme_station(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_polling_scheme_station_seat_num
            ON polling_scheme_station (seat_name, polling_station_num);
        CREATE INDEX IF NOT EXISTS idx_polling_scheme_match_prov_station
            ON polling_scheme_match (prov_station_id);
    """)

    with conn:
        # Wipe in FK-safe order
        conn.execute("DELETE FROM polling_scheme_match")
        conn.execute("DELETE FROM polling_scheme_station_block_code")
        conn.execute("DELETE FROM polling_scheme_station")

        # Insert stations
        conn.executemany(
            """
            INSERT INTO polling_scheme_station
                (id, seat_name, seat_type, polling_station_num, station_name, total_reg_voters)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    sid,
                    ref.seat_name,
                    "National" if ref.seat_name.lower().startswith("na_") else "Provincial",
                    ref.polling_station_num,
                    ref.name,
                    ref.total_reg_voters,
                )
                for sid, ref in station_payloads.items()
            ],
        )

        # Insert block codes
        conn.executemany(
            "INSERT INTO polling_scheme_station_block_code (station_id, block_code) VALUES (?, ?)",
            [
                (sid, bc)
                for sid, ref in station_payloads.items()
                for bc in ref.block_codes
            ],
        )

        # Insert matches (only records where prov is not null)
        conn.executemany(
            """
            INSERT INTO polling_scheme_match
                (nat_station_id, prov_station_id, matching_block_codes,
                 total_reg_voters_equal, total_reg_voters_delta, name_score)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    nat_id,
                    prov_id,
                    json.dumps(rec.matching_block_codes),
                    rec.total_reg_voters_equal,
                    rec.total_reg_voters_delta,
                    rec.name_score,
                )
                for rec, nat_id, prov_id in matched_pairs
            ],
        )

    conn.close()
    return {
        "stations": len(station_payloads),
        "matches": len(matched_pairs),
        "total_records": len(records),
    }


@app.get("/api/session")
async def get_session_state(session_id: Optional[str] = Cookie(default=None)):
    """Get current session state for restoring UI on page reload."""
    if not session_id:
        return {"session": None}

    session = get_session(session_id)
    if not session:
        return {"session": None}

    step = get_session_step(session)

    return {
        "session": {
            "id": session["id"],
            "step": step,
            "pdf_name": session["pdf_name"],
            "page_count": session["page_count"],
            "processed_pages": session["processed_pages"],
            "schema_fields": session["schema_fields"],
            "candidate_1": session["candidate_1"],
            "candidate_2": session["candidate_2"],
            "pending_pages": session["pending_pages"],
            "pending_form_data": session["pending_form_data"],
            "province": session["province"],
            "seat_type": session["seat_type"],
            "comparison_source": session["comparison_source"],
        }
    }


@app.post("/api/session/reset")
async def reset_session(response: FastAPIResponse, session_id: Optional[str] = Cookie(default=None)):
    """Start a new session without deleting the current one."""
    new_session_id = create_session()
    response.set_cookie(key="session_id", value=new_session_id, httponly=True, samesite="lax")
    return {"status": "ok", "session_id": new_session_id}


@app.post("/api/session/clear-pending")
async def clear_pending(session_id: Optional[str] = Cookie(default=None)):
    """Clear pending verification data without affecting processed pages."""
    if not session_id:
        raise HTTPException(400, "No session")

    session = get_session(session_id)
    if not session:
        raise HTTPException(400, "Session not found")

    update_session(session_id, pending_pages=None, pending_form_data=None)
    return {"status": "ok"}


@app.post("/api/upload")
async def upload_pdf(file: UploadFile, response: FastAPIResponse, session_id: Optional[str] = Cookie(default=None)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "File must be a PDF")

    # Get or create session
    if not session_id or not get_session(session_id):
        session_id = create_session()
        response.set_cookie(key="session_id", value=session_id, httponly=True, samesite="lax")
    else:
        # Clear old PDF if exists
        session = get_session(session_id)
        if session and session["pdf_path"]:
            old_path = Path(session["pdf_path"])
            if old_path.exists():
                old_path.unlink()

    # Save PDF to uploads directory
    pdf_path = UPLOADS_DIR / f"{session_id}.pdf"
    content = await file.read()
    pdf_path.write_bytes(content)

    # Get page count
    doc = fitz.open(pdf_path)
    page_count = len(doc)
    doc.close()

    # Update session
    update_session(
        session_id,
        pdf_name=file.filename,
        pdf_path=str(pdf_path),
        page_count=page_count,
        processed_pages=[],
        schema_fields=[],
        candidate_1_name=None,
        candidate_1_row=None,
        candidate_2_name=None,
        candidate_2_row=None,
    )

    return {
        "filename": file.filename,
        "page_count": page_count,
    }


@app.post("/api/sessions/import-csv")
async def import_session_from_csv(
    file: UploadFile,
    province: str = Form(...),
    seat_type: str = Form(...),
):
    """Create a new session from a CSV previously exported by this app.

    Expects the exact format produced by ``/api/polling-stations/export``:
    headers ``name,pages,{field}_type,{field}_value,...`` and one row per
    approved polling station. Candidate names are reverse-engineered from the
    ``*_col3`` field names (snake_case → Title Case).
    """
    import csv as _csv
    import io as _io

    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(400, "File must be a .csv file")
    if seat_type not in ("National", "Provincial"):
        raise HTTPException(400, "seat_type must be 'National' or 'Provincial'")
    if province not in PROVINCES:
        raise HTTPException(400, f"province must be one of {PROVINCES}")

    content = await file.read()
    try:
        text = content.decode("utf-8-sig")  # strip BOM if present
    except UnicodeDecodeError:
        raise HTTPException(400, "CSV must be UTF-8 encoded")

    reader = _csv.reader(_io.StringIO(text))
    try:
        header = next(reader)
    except StopIteration:
        raise HTTPException(400, "CSV is empty")

    if len(header) < 2 or header[0] != "name" or header[1] != "pages":
        raise HTTPException(400, "CSV must start with 'name,pages' columns")

    # Walk the header in pairs: ({field}_type, {field}_value).
    fields = []
    i = 2
    while i < len(header):
        h = header[i]
        if not h.endswith("_type"):
            raise HTTPException(400, f"Unexpected header '{h}' at column {i + 1} (expected *_type)")
        field_name = h[:-5]
        if i + 1 >= len(header) or header[i + 1] != f"{field_name}_value":
            raise HTTPException(400, f"Header mismatch at column {i + 2}: expected '{field_name}_value'")
        fields.append({"name": field_name, "type_col": i, "value_col": i + 1})
        i += 2

    # Derive candidate names from the two *_col3 fields.
    col3_fields = [f["name"][:-5] for f in fields if f["name"].endswith("_col3")]
    if len(col3_fields) != 2:
        raise HTTPException(400, f"Expected exactly 2 '*_col3' fields in CSV, found {len(col3_fields)}")
    c1_snake, c2_snake = col3_fields
    c1_name = " ".join(p.capitalize() for p in c1_snake.split("_"))
    c2_name = " ".join(p.capitalize() for p in c2_snake.split("_"))

    # Parse data rows into {name, pages, form_data} triples.
    stations = []
    all_pages: set = set()
    for row in reader:
        if not row or not row[0]:
            continue
        station_name = row[0]
        pages_str = row[1] if len(row) > 1 else ""
        pages: list[int] = []
        for p in (pages_str or "").split(","):
            p = p.strip()
            if not p:
                continue
            try:
                pages.append(int(p) - 1)  # CSV uses 1-indexed page numbers
            except ValueError:
                continue
        all_pages.update(pages)

        form_data: dict = {}
        for f in fields:
            type_val = row[f["type_col"]] if f["type_col"] < len(row) else ""
            value_val = row[f["value_col"]] if f["value_col"] < len(row) else ""
            type_val = (type_val or "").strip()
            value_val = (value_val or "").strip()
            if not type_val and value_val == "":
                continue  # field was absent from this station
            parsed_value: Optional[int] = None
            if value_val != "":
                try:
                    parsed_value = int(value_val)
                except ValueError:
                    parsed_value = None
            form_data[f["name"]] = {
                "type": type_val or "regular",
                "value": parsed_value,
            }

        stations.append({"name": station_name, "pages": pages, "form_data": form_data})

    if not stations:
        raise HTTPException(400, "CSV has no data rows")

    # Derive display name from filename; strip trailing ".csv".
    pdf_name = file.filename
    if pdf_name.lower().endswith(".csv"):
        pdf_name = pdf_name[:-4]

    # page_count needs to be large enough for `processed_pages` to represent
    # 100% completion; use max(page indices) + 1, falling back to station count.
    if all_pages:
        page_count = max(all_pages) + 1
        processed_pages = sorted(all_pages)
    else:
        page_count = len(stations)
        processed_pages = list(range(len(stations)))

    # Minimal schema_fields list — mirrors generate_schema_fields() output but
    # without row-hint aliases (the imported session will never run OCR again).
    schema_fields = [
        {"name": "total_registered_voters", "alias": "Total Registered Voters"},
        {"name": f"{c1_snake}_col3", "alias": f"{c1_name} Votes column 3"},
        {"name": f"{c1_snake}_col6", "alias": f"{c1_name} Votes column 6"},
        {"name": f"{c2_snake}_col3", "alias": f"{c2_name} Votes column 3"},
        {"name": f"{c2_snake}_col6", "alias": f"{c2_name} Votes column 6"},
        {"name": "row_a", "alias": "Row A"},
        {"name": "row_b", "alias": "Row B"},
        {"name": "row_c", "alias": "Row C"},
        {"name": "row_d", "alias": "Row D"},
    ]

    sid = create_session()
    update_session(
        sid,
        pdf_name=pdf_name,
        pdf_path=None,
        page_count=page_count,
        processed_pages=processed_pages,
        schema_fields=schema_fields,
        candidate_1_name=c1_name,
        candidate_1_row=None,
        candidate_2_name=c2_name,
        candidate_2_row=None,
        province=province,
        seat_type=seat_type,
    )

    conn = sqlite3.connect(DB_PATH)
    conn.executemany(
        "INSERT INTO polling_station_queue (session_id, name, pages, status, form_data, source) "
        "VALUES (?, ?, ?, 'approved', ?, 'ecp')",
        [
            (sid, s["name"], json.dumps(s["pages"]), json.dumps(s["form_data"]))
            for s in stations
        ],
    )
    conn.commit()
    conn.close()

    return {
        "session_id": sid,
        "pdf_name": pdf_name,
        "station_count": len(stations),
    }


@app.post("/api/upload/bulk")
async def bulk_upload_pdfs(files: list[UploadFile]):
    """Upload multiple PDFs, each becoming its own session."""
    results = []
    for file in files:
        if not file.filename.lower().endswith(".pdf"):
            continue

        sid = create_session()
        pdf_path = UPLOADS_DIR / f"{sid}.pdf"
        content = await file.read()
        pdf_path.write_bytes(content)

        doc = fitz.open(pdf_path)
        page_count = len(doc)
        doc.close()

        update_session(
            sid,
            pdf_name=file.filename,
            pdf_path=str(pdf_path),
            page_count=page_count,
            processed_pages=[],
            schema_fields=[],
        )

        results.append({"id": sid, "pdf_name": file.filename, "page_count": page_count})

    return {"sessions": results}


def generate_schema_fields(candidate_1: CandidateInfo, candidate_2: CandidateInfo) -> list[dict]:
    """Generate the full schema fields from just the two candidate names/rows."""
    c1_snake = candidate_1.name.lower().replace(" ", "_")
    c2_snake = candidate_2.name.lower().replace(" ", "_")

    return [
        {"name": "total_registered_voters", "alias": "Total Registered Voters (First row 'Kul Tadaad') (could also be empty)"},
        {"name": f"{c1_snake}_col3", "alias": f"{candidate_1.name} (row {candidate_1.row}) Votes column 3"},
        {"name": f"{c1_snake}_col6", "alias": f"{candidate_1.name} (row {candidate_1.row}) Votes column 6"},
        {"name": f"{c2_snake}_col3", "alias": f"{candidate_2.name} (row {candidate_2.row}) Votes column 3"},
        {"name": f"{c2_snake}_col6", "alias": f"{candidate_2.name} (row {candidate_2.row}) Votes column 6"},
        {"name": "row_a", "alias": "Row A"},
        {"name": "row_b", "alias": "Row B"},
        {"name": "row_c", "alias": "Row C"},
        {"name": "row_d", "alias": "Row D (left-most number only)"},
    ]


SKEW_THRESHOLD = 1.033  # degrees


def compute_flags(form_data: dict, candidate_1_name: str, candidate_2_name: str) -> list[str]:
    """Compute validation flags for a polling station's form data."""
    flags = []

    c1_prefix = candidate_1_name.lower().replace(" ", "_")
    c2_prefix = candidate_2_name.lower().replace(" ", "_")

    # Check col3 vs col6 mismatch for each candidate
    for prefix, name in [(c1_prefix, candidate_1_name), (c2_prefix, candidate_2_name)]:
        col3_field = f"{prefix}_col3"
        col6_field = f"{prefix}_col6"

        col3_data = form_data.get(col3_field, {})
        col6_data = form_data.get(col6_field, {})

        col3_val = col3_data.get("value")
        col6_val = col6_data.get("value")

        if col3_val is not None and col6_val is not None and col3_val != col6_val:
            flags.append(f"vote_mismatch:{name}")

    # Check for excessive skew on any page
    skew_angles = form_data.get("_skew_angles", [])
    for i, angle in enumerate(skew_angles):
        if abs(angle) > SKEW_THRESHOLD:
            flags.append(f"excessive_skew:page_{i + 1}:{angle:.3f}")

    return flags


@app.post("/api/schema")
async def set_schema(schema: SchemaDefinition, session_id: Optional[str] = Cookie(default=None)):
    if not session_id:
        raise HTTPException(400, "No session")

    session = get_session(session_id)
    if not session or not session["pdf_name"]:
        raise HTTPException(400, "No PDF uploaded")

    schema_fields = generate_schema_fields(schema.candidate_1, schema.candidate_2)

    update_session(
        session_id,
        schema_fields=schema_fields,
        candidate_1_name=schema.candidate_1.name,
        candidate_1_row=schema.candidate_1.row,
        candidate_2_name=schema.candidate_2.name,
        candidate_2_row=schema.candidate_2.row,
        province=schema.province,
        seat_type=schema.seat_type,
    )

    return {"status": "ok", "field_count": len(schema_fields)}


@app.get("/api/schema")
async def get_schema(session_id: Optional[str] = Cookie(default=None)):
    if not session_id:
        return {"fields": []}
    session = get_session(session_id)
    return {"fields": session["schema_fields"] if session else []}


@app.get("/api/pages")
async def get_pages(session_id: Optional[str] = Cookie(default=None)):
    if not session_id:
        raise HTTPException(400, "No session")

    session = get_session(session_id)
    if not session or not session["pdf_path"]:
        raise HTTPException(400, "No PDF uploaded")

    return {
        "page_count": session["page_count"],
        "processed_pages": session["processed_pages"],
    }


@app.get("/api/page/{page_num}/image")
async def get_page_image(page_num: int, session_id: Optional[str] = Cookie(default=None)):
    if not session_id:
        raise HTTPException(400, "No session")

    session = get_session(session_id)
    if not session or not session["pdf_path"]:
        raise HTTPException(400, "No PDF uploaded")
    if page_num < 0 or page_num >= session["page_count"]:
        raise HTTPException(400, "Invalid page number")

    doc = fitz.open(session["pdf_path"])
    page = doc[page_num]
    pix = page.get_pixmap(dpi=150)
    img_bytes = pix.tobytes("png")
    doc.close()

    return Response(content=img_bytes, media_type="image/png")


@app.get("/api/page/{page_num}/thumbnail")
async def get_page_thumbnail(page_num: int, session_id: Optional[str] = Cookie(default=None)):
    if not session_id:
        raise HTTPException(400, "No session")

    session = get_session(session_id)
    if not session or not session["pdf_path"]:
        raise HTTPException(400, "No PDF uploaded")
    if page_num < 0 or page_num >= session["page_count"]:
        raise HTTPException(400, "Invalid page number")

    doc = fitz.open(session["pdf_path"])
    page = doc[page_num]
    pix = page.get_pixmap(dpi=50)
    img_bytes = pix.tobytes("png")
    doc.close()

    return Response(content=img_bytes, media_type="image/png")


@app.post("/api/process")
async def process_pages(req: ProcessRequest, session_id: Optional[str] = Cookie(default=None)):
    if not session_id:
        raise HTTPException(400, "No session")

    session = get_session(session_id)
    if not session or not session["pdf_path"]:
        raise HTTPException(400, "No PDF uploaded")
    if not session["schema_fields"]:
        raise HTTPException(400, "Schema not defined")

    for p in req.pages:
        if p < 0 or p >= session["page_count"]:
            raise HTTPException(400, f"Invalid page number: {p}")

    # Build dynamic Pydantic model from schema
    field_definitions = {}
    for f in session["schema_fields"]:
        field_definitions[f["name"]] = (VoteValue, Field(alias=f["alias"]))

    DynamicForm = create_model(
        "DynamicForm",
        __config__=ConfigDict(populate_by_name=True),
        **field_definitions,
    )

    # Extract page images
    doc = fitz.open(session["pdf_path"])
    images = []
    for page_num in req.pages:
        page = doc[page_num]
        pix = page.get_pixmap(dpi=150)
        images.append(pix.tobytes("png"))
    doc.close()

    # Build prompt
    prompt = """Analyze this election form and extract the values into the specified schema.
For each field, determine if the value is:
- "regular": A clear, unmodified number
- "crossed": The value has been crossed out
- "crossedAndCorrected": Crossed out with a new value written
- "overwritten": Written over with a different value
- "illegible": Cannot be read clearly
- "blank": No value present

Extract the data according to the field names in the schema."""

    # Build content with images
    content_parts = [{"type": "text", "text": prompt}]
    for img_bytes in images:
        content_parts.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64.b64encode(img_bytes).decode()}"}})

    # Call Gemini with rate limiting and retry
    response = await call_gemini_with_retry(content_parts, DynamicForm, provider=req.provider, model=req.model)

    # Parse and return
    result = DynamicForm.model_validate_json(response.choices[0].message.content)
    form_data = result.model_dump()

    # Save pending data to session so it can be restored
    update_session(
        session_id,
        pending_pages=list(req.pages),
        pending_form_data=form_data,
    )

    return form_data


@app.post("/api/approve")
async def approve_data(req: ApproveRequest, session_id: Optional[str] = Cookie(default=None)):
    if not session_id:
        raise HTTPException(400, "No session")

    session = get_session(session_id)
    if not session or not session["pdf_name"]:
        raise HTTPException(400, "No PDF uploaded")

    # Save to polling_stations
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO polling_stations (session_id, pdf_name, page_numbers, form_data) VALUES (?, ?, ?, ?)",
        (session_id, session["pdf_name"], json.dumps(req.pages), json.dumps(req.form_data)),
    )
    conn.commit()
    conn.close()

    # Update processed pages and clear pending data
    processed = set(session["processed_pages"])
    processed.update(req.pages)
    update_session(
        session_id,
        processed_pages=list(processed),
        pending_pages=None,
        pending_form_data=None,
    )

    return {
        "status": "ok",
        "processed_pages": list(processed),
        "remaining": session["page_count"] - len(processed),
    }


@app.get("/api/results")
async def get_results(session_id: Optional[str] = Cookie(default=None)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    if session_id:
        rows = conn.execute(
            "SELECT * FROM polling_stations WHERE session_id = ? ORDER BY created_at DESC",
            (session_id,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM polling_stations ORDER BY created_at DESC"
        ).fetchall()
    conn.close()

    return [
        {
            "id": r["id"],
            "pdf_name": r["pdf_name"],
            "page_numbers": json.loads(r["page_numbers"]),
            "form_data": json.loads(r["form_data"]),
            "created_at": r["created_at"],
        }
        for r in rows
    ]


# --- Polling Station Queue Endpoints ---

@app.get("/api/polling-stations")
async def list_polling_stations(session_id: Optional[str] = Cookie(default=None)):
    """List all polling stations for current session, grouped by status."""
    if not session_id:
        return {"pending": [], "processed": [], "approved": []}

    session = get_session(session_id)
    if not session:
        return {"pending": [], "processed": [], "approved": []}

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM polling_station_queue WHERE session_id = ? ORDER BY id ASC",
        (session_id,)
    ).fetchall()

    # Build set of matched (seat_name, station_num) pairs for this session
    seat_name = normalize_seat_name(session.get("pdf_name"))
    matched_pairs = set()
    if seat_name:
        matched_rows = conn.execute("""
            SELECT pss.polling_station_num
            FROM polling_scheme_station pss
            JOIN polling_scheme_match psm ON psm.nat_station_id = pss.id
            WHERE pss.seat_name = ?
        """, (seat_name,)).fetchall()
        matched_pairs = {r["polling_station_num"] for r in matched_rows}
    conn.close()

    station_num_re = re.compile(r'^Polling Station\s+(\d+)$')

    result = {"pending": [], "processed": [], "approved": []}
    for r in rows:
        form_data = json.loads(r["form_data"]) if r["form_data"] else None
        flags = []
        if form_data and session["candidate_1"] and session["candidate_2"]:
            flags = compute_flags(
                form_data,
                session["candidate_1"]["name"],
                session["candidate_2"]["name"]
            )
        pscm_matched = False
        source = r["source"] if "source" in r.keys() else "ecp"
        if source == "ecp" and matched_pairs:
            m = station_num_re.match(r["name"])
            if m and int(m.group(1)) in matched_pairs:
                pscm_matched = True
        item = {
            "id": r["id"],
            "name": r["name"],
            "pages": json.loads(r["pages"]),
            "status": r["status"],
            "source": source,
            "form_data": form_data,
            "flags": flags,
            "pscm_matched": pscm_matched,
        }
        result[r["status"]].append(item)

    return result


@app.post("/api/polling-station")
async def create_polling_station(req: CreatePollingStationRequest, session_id: Optional[str] = Cookie(default=None)):
    """Create a polling station from selected pages."""
    if not session_id:
        raise HTTPException(400, "No session")

    session = get_session(session_id)
    if not session or not session["pdf_path"]:
        raise HTTPException(400, "No PDF uploaded")

    # Validate page numbers
    for p in req.pages:
        if p < 0 or p >= session["page_count"]:
            raise HTTPException(400, f"Invalid page number: {p}")

    # Check pages aren't already in another polling station
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    existing = conn.execute(
        "SELECT pages FROM polling_station_queue WHERE session_id = ?",
        (session_id,)
    ).fetchall()

    used_pages = set()
    for row in existing:
        used_pages.update(json.loads(row["pages"]))

    for p in req.pages:
        if p in used_pages:
            conn.close()
            raise HTTPException(400, f"Page {p + 1} is already in another polling station")

    # Get next polling station number
    count = conn.execute(
        "SELECT COUNT(*) FROM polling_station_queue WHERE session_id = ?",
        (session_id,)
    ).fetchone()[0]
    name = f"Polling Station {count + 1}"

    # Create the polling station
    cursor = conn.execute(
        "INSERT INTO polling_station_queue (session_id, name, pages, status) VALUES (?, ?, ?, 'pending')",
        (session_id, name, json.dumps(req.pages))
    )
    station_id = cursor.lastrowid
    conn.commit()
    conn.close()

    return {
        "id": station_id,
        "name": name,
        "pages": req.pages,
        "status": "pending",
    }


@app.post("/api/polling-stations/batch-create")
async def batch_create_polling_stations(req: BatchCreatePollingStationsRequest, session_id: Optional[str] = Cookie(default=None)):
    """Create multiple polling stations at once."""
    if not session_id:
        raise HTTPException(400, "No session")

    session = get_session(session_id)
    if not session or not session["pdf_path"]:
        raise HTTPException(400, "No PDF uploaded")

    # Validate all pages
    all_pages = [p for group in req.page_groups for p in group]
    for p in all_pages:
        if p < 0 or p >= session["page_count"]:
            raise HTTPException(400, f"Invalid page number: {p}")

    # Check for duplicates within the request
    if len(all_pages) != len(set(all_pages)):
        raise HTTPException(400, "Duplicate pages in request")

    # Check pages aren't already used
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    existing = conn.execute(
        "SELECT pages FROM polling_station_queue WHERE session_id = ?",
        (session_id,)
    ).fetchall()

    used_pages = set()
    for row in existing:
        used_pages.update(json.loads(row["pages"]))

    for p in all_pages:
        if p in used_pages:
            conn.close()
            raise HTTPException(400, f"Page {p + 1} is already in another polling station")

    # Get current count for naming
    count = conn.execute(
        "SELECT COUNT(*) FROM polling_station_queue WHERE session_id = ?",
        (session_id,)
    ).fetchone()[0]

    # Insert all in one transaction
    stations = []
    for i, pages in enumerate(req.page_groups):
        name = f"Polling Station {count + i + 1}"
        cursor = conn.execute(
            "INSERT INTO polling_station_queue (session_id, name, pages, status) VALUES (?, ?, ?, 'pending')",
            (session_id, name, json.dumps(pages))
        )
        stations.append({"id": cursor.lastrowid, "name": name, "pages": pages, "status": "pending"})

    conn.commit()
    conn.close()

    return {"stations": stations}


@app.post("/api/detect-page-labels")
async def detect_page_labels(req: DetectPageLabelsRequest, session_id: Optional[str] = Cookie(default=None)):
    """Detect page labels for smart polling station creation."""
    if not session_id:
        raise HTTPException(400, "No session")
    session = get_session(session_id)
    if not session or not session["pdf_path"]:
        raise HTTPException(400, "No PDF uploaded")

    page_count = session["page_count"]
    start = req.start_page
    end = req.end_page if req.end_page is not None else page_count
    if start < 0 or end > page_count or start >= end:
        raise HTTPException(400, "Invalid page range")

    all_pages = list(range(start, end))

    # Extract images at low DPI, no deskew for speed
    images, _ = await extract_page_images(session["pdf_path"], all_pages, dpi=100, deskew=False)

    # Batch images into groups of max_pages
    batches = []
    for i in range(0, len(images), req.max_pages):
        batches.append(images[i:i + req.max_pages])

    # Build prompt
    rows_hint = ""
    if req.max_rows > 0:
        rows_hint = f"\nEach station has at most {req.max_rows} rows total across all its pages. Use visible row numbers as a clue: if row numbering resets to 1, that image is page 1. If the row numbers reach or approach {req.max_rows}, that image is likely the last page of the station."

    prompt = f"""Look at each image in order. For each one, identify the page number of the election form.
Always return a numeric page number. If you are not certain, make your best guess.
Return exactly one integer per image, in the same order.
Valid page numbers are between 1 and {req.max_pages}. Do not return a page number outside this range.
The last page (page {req.max_pages}) contains summary information and is identifiable by rows labeled (A), (B), (C), and (D) at the bottom in addition to regular numbered rows.{rows_hint}"""

    # Process each batch concurrently
    async def process_batch(batch_images):
        content_parts = [{"type": "text", "text": prompt}]
        for img_bytes in batch_images:
            content_parts.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64.b64encode(img_bytes).decode()}"}})
        response = await call_gemini_with_retry(
            content_parts, PageGuesses, schema_name="PageGuesses",
            provider=req.provider, model=req.model
        )
        result = PageGuesses.model_validate_json(response.choices[0].message.content)
        return result.pages

    tasks = [process_batch(batch) for batch in batches]
    batch_results = await asyncio.gather(*tasks)

    # Flatten results
    page_labels = []
    for result in batch_results:
        page_labels.extend(result)

    # Ensure we have the right number of labels
    if len(page_labels) != len(all_pages):
        raise HTTPException(500, f"Expected {len(all_pages)} labels, got {len(page_labels)}")

    # Store as full-length list indexed by absolute page number
    full_labels = [0] * page_count
    for i, page_idx in enumerate(all_pages):
        full_labels[page_idx] = page_labels[i]

    # Save to session
    update_session(session_id, page_labels=full_labels)

    # Compute summary
    max_pages = req.max_pages
    complete_forms = 0
    anomalous_forms = 0
    current = []
    for label in page_labels:
        if label == 1 and current:
            expected = list(range(1, max_pages + 1))
            if current == expected:
                complete_forms += 1
            else:
                anomalous_forms += 1
            current = []
        current.append(label)
    if current:
        expected = list(range(1, max_pages + 1))
        if current == expected:
            complete_forms += 1
        else:
            anomalous_forms += 1

    return {
        "page_labels": page_labels,
        "summary": {
            "total": complete_forms + anomalous_forms,
            "complete_forms": complete_forms,
            "anomalous_forms": anomalous_forms,
        }
    }


@app.post("/api/polling-stations/smart-create")
async def smart_create_polling_stations(req: SmartCreateRequest, session_id: Optional[str] = Cookie(default=None)):
    """Create polling stations using detected page labels."""
    if not session_id:
        raise HTTPException(400, "No session")
    session = get_session(session_id)
    if not session or not session["pdf_path"]:
        raise HTTPException(400, "No PDF uploaded")
    if not session.get("page_labels"):
        raise HTTPException(400, "No page labels detected. Run detect-page-labels first.")

    page_labels = session["page_labels"]
    page_count = session["page_count"]
    start = req.start_page
    end = req.end_page if req.end_page is not None else page_count
    if start < 0 or end > page_count or start >= end:
        raise HTTPException(400, "Invalid page range")

    # Get used pages
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    existing = conn.execute(
        "SELECT pages FROM polling_station_queue WHERE session_id = ?",
        (session_id,)
    ).fetchall()
    used_pages = set()
    for row in existing:
        used_pages.update(json.loads(row["pages"]))

    # Filter to unused pages in range
    unused_pages = [i for i in range(start, end) if i not in used_pages]

    if not unused_pages:
        conn.close()
        raise HTTPException(400, "No unused pages in the specified range")

    # Group by page-1 boundaries
    groups = []
    current = []
    for idx in unused_pages:
        if idx < len(page_labels):
            label = page_labels[idx]
        else:
            label = 0
        if label == 1 and current:
            groups.append(current)
            current = []
        current.append(idx)
    if current:
        groups.append(current)

    # Get current count for naming
    count = conn.execute(
        "SELECT COUNT(*) FROM polling_station_queue WHERE session_id = ?",
        (session_id,)
    ).fetchone()[0]

    # Insert stations
    stations = []
    anomaly_count = 0
    expected = list(range(1, req.max_pages + 1))
    for i, group in enumerate(groups):
        actual = [page_labels[p] if p < len(page_labels) else 0 for p in group]
        is_anomaly = actual != expected
        if is_anomaly:
            anomaly_count += 1
        name = f"Polling Station {count + i + 1}"
        if is_anomaly:
            name += " [!]"
        cursor = conn.execute(
            "INSERT INTO polling_station_queue (session_id, name, pages, status) VALUES (?, ?, ?, 'pending')",
            (session_id, name, json.dumps(group))
        )
        stations.append({"id": cursor.lastrowid, "name": name, "pages": group, "status": "pending"})

    conn.commit()
    conn.close()

    return {"stations": stations, "anomaly_count": anomaly_count}


@app.get("/api/polling-station/{station_id}")
async def get_polling_station(station_id: int, session_id: Optional[str] = Cookie(default=None)):
    """Get a specific polling station's details."""
    if not session_id:
        raise HTTPException(400, "No session")

    session = get_session(session_id)
    if not session:
        raise HTTPException(400, "Session not found")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT * FROM polling_station_queue WHERE id = ? AND session_id = ?",
        (station_id, session_id)
    ).fetchone()
    conn.close()

    if not row:
        raise HTTPException(404, "Polling station not found")

    form_data = json.loads(row["form_data"]) if row["form_data"] else None
    flags = []
    if form_data and session["candidate_1"] and session["candidate_2"]:
        flags = compute_flags(
            form_data,
            session["candidate_1"]["name"],
            session["candidate_2"]["name"]
        )

    return {
        "id": row["id"],
        "name": row["name"],
        "pages": json.loads(row["pages"]),
        "status": row["status"],
        "form_data": form_data,
        "flags": flags,
    }


@app.delete("/api/polling-station/{station_id}")
async def delete_polling_station(station_id: int, session_id: Optional[str] = Cookie(default=None)):
    """Delete a polling station, freeing its pages for reselection."""
    if not session_id:
        raise HTTPException(400, "No session")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT * FROM polling_station_queue WHERE id = ? AND session_id = ?",
        (station_id, session_id)
    ).fetchone()

    if not row:
        conn.close()
        raise HTTPException(404, "Polling station not found")

    pages = json.loads(row["pages"])
    status = row["status"]

    # If approved, also remove from processed_pages in session
    if status == "approved":
        session = get_session(session_id)
        processed = set(session["processed_pages"])
        processed.difference_update(pages)
        update_session(session_id, processed_pages=list(processed))
    conn.execute("DELETE FROM polling_station_queue WHERE id = ?", (station_id,))
    conn.commit()
    conn.close()

    return {"status": "ok", "freed_pages": pages}


@app.delete("/api/polling-stations/by-status/{status}")
async def delete_all_by_status(status: str, session_id: Optional[str] = Cookie(default=None)):
    """Delete all polling stations with the given status."""
    if not session_id:
        raise HTTPException(400, "No session")
    if status not in ("pending", "processed", "approved"):
        raise HTTPException(400, "Invalid status")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, pages FROM polling_station_queue WHERE session_id = ? AND status = ? AND source = 'ecp'",
        (session_id, status)
    ).fetchall()

    if not rows:
        conn.close()
        return {"deleted": 0}

    # If deleting approved stations, update processed_pages in session
    if status == "approved":
        all_pages = set()
        for row in rows:
            all_pages.update(json.loads(row["pages"]))
        session = get_session(session_id)
        processed = set(session["processed_pages"])
        processed.difference_update(all_pages)
        update_session(session_id, processed_pages=list(processed))

    conn.execute(
        "DELETE FROM polling_station_queue WHERE session_id = ? AND status = ? AND source = 'ecp'",
        (session_id, status)
    )
    conn.commit()
    conn.close()

    return {"deleted": len(rows)}


@app.post("/api/polling-stations/batch-delete")
async def batch_delete_polling_stations(req: BulkActionRequest, session_id: Optional[str] = Cookie(default=None)):
    """Delete specific polling stations by IDs."""
    if not session_id:
        raise HTTPException(400, "No session")
    if not req.ids:
        return {"deleted": 0}

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    placeholders = ','.join('?' * len(req.ids))
    rows = conn.execute(
        f"SELECT id, pages, status FROM polling_station_queue WHERE session_id = ? AND id IN ({placeholders})",
        (session_id, *req.ids)
    ).fetchall()

    if not rows:
        conn.close()
        return {"deleted": 0}

    # If deleting approved stations, update processed_pages
    approved_pages = set()
    for row in rows:
        if row["status"] == "approved":
            approved_pages.update(json.loads(row["pages"]))
    if approved_pages:
        session = get_session(session_id)
        processed = set(session["processed_pages"])
        processed.difference_update(approved_pages)
        update_session(session_id, processed_pages=list(processed))

    ids_to_delete = [r["id"] for r in rows]
    conn.execute(
        f"DELETE FROM polling_station_queue WHERE id IN ({','.join('?' * len(ids_to_delete))})",
        ids_to_delete
    )
    conn.commit()
    conn.close()

    return {"deleted": len(ids_to_delete)}


@app.patch("/api/polling-station/{station_id}")
async def rename_polling_station(station_id: int, req: RenamePollingStationRequest, session_id: Optional[str] = Cookie(default=None)):
    """Rename a polling station. Name must be unique within the session."""
    if not session_id:
        raise HTTPException(400, "No session")

    new_name = req.name.strip()
    if not new_name:
        raise HTTPException(400, "Name cannot be empty")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Check station exists
    row = conn.execute(
        "SELECT * FROM polling_station_queue WHERE id = ? AND session_id = ?",
        (station_id, session_id)
    ).fetchone()

    if not row:
        conn.close()
        raise HTTPException(404, "Polling station not found")

    # Check for name clash (excluding current station)
    existing = conn.execute(
        "SELECT id FROM polling_station_queue WHERE session_id = ? AND name = ? AND id != ?",
        (session_id, new_name, station_id)
    ).fetchone()

    if existing:
        conn.close()
        raise HTTPException(400, f"A polling station named '{new_name}' already exists")

    # Update name
    conn.execute(
        "UPDATE polling_station_queue SET name = ? WHERE id = ?",
        (new_name, station_id)
    )
    conn.commit()
    conn.close()

    return {"status": "ok", "name": new_name}


@app.post("/api/polling-stations/renumber")
async def renumber_polling_stations(req: RenumberRequest, session_id: Optional[str] = Cookie(default=None)):
    """Bulk rename stations: all stations with trailing number >= from_number get offset added."""
    if not session_id:
        raise HTTPException(400, "No session")
    if req.offset == 0:
        raise HTTPException(400, "Offset cannot be zero")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        "SELECT id, name FROM polling_station_queue WHERE session_id = ?",
        (session_id,)
    ).fetchall()

    pattern = re.compile(r'(\d+)\s*$')

    # Parse trailing numbers and split into selected vs unselected
    selected = []  # (id, name, parsed_number)
    unselected_names = set()
    for row in rows:
        m = pattern.search(row["name"])
        if m:
            num = int(m.group(1))
            if num >= req.from_number:
                selected.append((row["id"], row["name"], num))
            else:
                unselected_names.add(row["name"])
        else:
            unselected_names.add(row["name"])

    if not selected:
        conn.close()
        raise HTTPException(400, f"No stations found with number >= {req.from_number}")

    # Compute new names and check for collisions
    renames = []
    for sid, name, num in selected:
        new_num = num + req.offset
        if new_num < 1:
            conn.close()
            raise HTTPException(400, f"Renumbering would make '{name}' have number {new_num} (< 1)")
        new_name = pattern.sub(str(new_num), name)
        renames.append((sid, new_name, num))

    # Check collisions with unselected stations
    new_names = {r[1] for r in renames}
    collisions = new_names & unselected_names
    if collisions:
        conn.close()
        raise HTTPException(400, f"Renumbering would collide with: {', '.join(sorted(collisions))}")

    # Sort to avoid intermediate collisions: highest first for positive offset, lowest first for negative
    renames.sort(key=lambda r: r[2], reverse=(req.offset > 0))

    for sid, new_name, _ in renames:
        conn.execute("UPDATE polling_station_queue SET name = ? WHERE id = ?", (new_name, sid))

    conn.commit()
    conn.close()

    return {"status": "ok", "renamed": len(renames)}


async def extract_page_images(pdf_path: str, pages: list[int], dpi: int = 150, deskew: bool = True) -> tuple[list[bytes], list[float]]:
    """Extract PDF pages as PNG bytes. Returns (images, skew_angles)."""
    def _extract():
        doc = fitz.open(pdf_path)
        imgs = []
        angles = []
        for page_num in pages:
            page = doc[page_num]
            pix = page.get_pixmap(dpi=dpi)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            if pix.n == 4:
                img = cv2.cvtColor(img, cv2.COLOR_RGBA2RGB)
            if deskew:
                img, skew_angle = deskew_image(img)
                angles.append(skew_angle)
            else:
                angles.append(0.0)
            _, png_bytes = cv2.imencode('.png', cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
            imgs.append(png_bytes.tobytes())
        doc.close()
        return imgs, angles
    return await asyncio.to_thread(_extract)


async def process_single_station(session_id: str, station_id: int, provider: str = "openrouter", model: str = "google/gemini-3-flash-preview") -> dict:
    """Process a single polling station with Gemini. Returns the form data."""
    session = get_session(session_id)
    if not session or not session["pdf_path"]:
        raise HTTPException(400, "No PDF uploaded")
    if not session["schema_fields"]:
        raise HTTPException(400, "Schema not defined")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT * FROM polling_station_queue WHERE id = ? AND session_id = ?",
        (station_id, session_id)
    ).fetchone()
    conn.close()

    if not row:
        raise HTTPException(404, "Polling station not found")
    if row["status"] != "pending":
        raise HTTPException(400, "Polling station is not pending")

    pages = json.loads(row["pages"])

    # Build dynamic Pydantic model from schema
    field_definitions = {}
    for f in session["schema_fields"]:
        field_definitions[f["name"]] = (VoteValue, Field(alias=f["alias"]))

    DynamicForm = create_model(
        "DynamicForm",
        __config__=ConfigDict(populate_by_name=True),
        **field_definitions,
    )

    images, skew_angles = await extract_page_images(session["pdf_path"], pages, dpi=150, deskew=True)

    # Build prompt
    prompt = """Analyze this election form and extract the values into the specified schema.
For each field, determine if the value is:
- "regular": A clear, unmodified number
- "crossed": The value has been crossed out
- "crossedAndCorrected": Crossed out with a new value written
- "overwritten": Written over with a different value
- "illegible": Cannot be read clearly
- "blank": No value present

Extract the data according to the field names in the schema."""

    # Build content with images
    content_parts = [{"type": "text", "text": prompt}]
    for img_bytes in images:
        content_parts.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64.b64encode(img_bytes).decode()}"}})

    # Call Gemini with rate limiting and retry
    response = await call_gemini_with_retry(content_parts, DynamicForm, provider=provider, model=model)

    # Parse result
    result = DynamicForm.model_validate_json(response.choices[0].message.content)
    form_data = result.model_dump()

    # Store skew angles as metadata
    form_data["_skew_angles"] = skew_angles

    # Update polling station with form data and status
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "UPDATE polling_station_queue SET status = 'processed', form_data = ? WHERE id = ?",
        (json.dumps(form_data), station_id)
    )
    conn.commit()
    conn.close()

    return {
        "id": station_id,
        "name": row["name"],
        "pages": pages,
        "status": "processed",
        "form_data": form_data,
    }


@app.post("/api/polling-station/{station_id}/process")
async def process_polling_station(station_id: int, req: AIProviderRequest = AIProviderRequest(), session_id: Optional[str] = Cookie(default=None)):
    """Process a single polling station with Gemini."""
    if not session_id:
        raise HTTPException(400, "No session")

    return await process_single_station(session_id, station_id, provider=req.provider, model=req.model)


@app.post("/api/polling-stations/batch-process")
async def batch_process_polling_stations(req: AIProviderRequest = AIProviderRequest(), session_id: Optional[str] = Cookie(default=None)):
    """Process all pending polling stations sequentially."""
    if not session_id:
        raise HTTPException(400, "No session")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    if req.ids:
        placeholders = ','.join('?' * len(req.ids))
        rows = conn.execute(
            f"SELECT id FROM polling_station_queue WHERE session_id = ? AND status = 'pending' AND id IN ({placeholders})",
            (session_id, *req.ids)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id FROM polling_station_queue WHERE session_id = ? AND status = 'pending'",
            (session_id,)
        ).fetchall()
    conn.close()

    if not rows:
        return {"processed": [], "errors": []}

    station_ids = [r["id"] for r in rows]

    # Process concurrently with a semaphore to limit parallelism
    sem = asyncio.Semaphore(300)
    processed = []
    errors = []

    async def process_one(sid):
        async with sem:
            try:
                result = await process_single_station(session_id, sid, provider=req.provider, model=req.model)
                processed.append(result)
            except Exception as e:
                errors.append({"id": sid, "error": str(e)})

    await asyncio.gather(*[process_one(sid) for sid in station_ids])

    return {"processed": processed, "errors": errors}


@app.post("/api/polling-station/{station_id}/approve")
async def approve_polling_station(station_id: int, req: ApprovePollingStationRequest, session_id: Optional[str] = Cookie(default=None)):
    """Approve a processed polling station and move to approved status."""
    if not session_id:
        raise HTTPException(400, "No session")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT * FROM polling_station_queue WHERE id = ? AND session_id = ?",
        (station_id, session_id)
    ).fetchone()

    if not row:
        conn.close()
        raise HTTPException(404, "Polling station not found")

    if row["status"] != "processed":
        conn.close()
        raise HTTPException(400, "Polling station is not processed")

    # Update with approved form data and status
    conn.execute(
        "UPDATE polling_station_queue SET status = 'approved', form_data = ? WHERE id = ?",
        (json.dumps(req.form_data), station_id)
    )
    conn.commit()
    conn.close()

    # Also update the session's processed_pages for progress tracking
    session = get_session(session_id)
    pages = json.loads(row["pages"])
    processed = set(session["processed_pages"])
    processed.update(pages)
    update_session(session_id, processed_pages=list(processed))

    return {
        "id": station_id,
        "status": "approved",
    }


@app.post("/api/polling-stations/bulk-approve")
async def bulk_approve_polling_stations(req: BulkActionRequest = BulkActionRequest(), session_id: Optional[str] = Cookie(default=None)):
    """Approve all (or selected) processed polling stations with their current form data."""
    if not session_id:
        raise HTTPException(400, "No session")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    if req.ids:
        placeholders = ','.join('?' * len(req.ids))
        rows = conn.execute(
            f"SELECT id, pages FROM polling_station_queue WHERE session_id = ? AND status = 'processed' AND id IN ({placeholders})",
            (session_id, *req.ids)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, pages FROM polling_station_queue WHERE session_id = ? AND status = 'processed'",
            (session_id,)
        ).fetchall()

    if not rows:
        conn.close()
        return {"approved": [], "count": 0}

    # Approve all processed stations
    station_ids = [r["id"] for r in rows]
    conn.execute(
        f"UPDATE polling_station_queue SET status = 'approved' WHERE id IN ({','.join('?' * len(station_ids))})",
        station_ids
    )
    conn.commit()
    conn.close()

    # Update session's processed_pages
    session = get_session(session_id)
    processed = set(session["processed_pages"])
    for row in rows:
        processed.update(json.loads(row["pages"]))
    update_session(session_id, processed_pages=list(processed))

    return {"approved": station_ids, "count": len(station_ids)}


@app.put("/api/polling-station/{station_id}/form-data")
async def update_polling_station_form_data(station_id: int, req: ApprovePollingStationRequest, session_id: Optional[str] = Cookie(default=None)):
    """Update form data for an approved polling station."""
    if not session_id:
        raise HTTPException(400, "No session")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT * FROM polling_station_queue WHERE id = ? AND session_id = ?",
        (station_id, session_id)
    ).fetchone()

    if not row:
        conn.close()
        raise HTTPException(404, "Polling station not found")

    if row["status"] != "approved":
        conn.close()
        raise HTTPException(400, "Can only update form data for approved polling stations")

    conn.execute(
        "UPDATE polling_station_queue SET form_data = ? WHERE id = ?",
        (json.dumps(req.form_data), station_id)
    )
    conn.commit()
    conn.close()

    return {
        "id": station_id,
        "status": "updated",
    }


@app.get("/api/polling-stations/export")
async def export_polling_stations_csv(session_id: Optional[str] = Cookie(default=None)):
    """Export all approved polling stations as a CSV file."""
    import csv
    import io

    if not session_id:
        raise HTTPException(400, "No session")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM polling_station_queue WHERE session_id = ? AND status = 'approved' AND source = 'ecp' ORDER BY id ASC",
        (session_id,)
    ).fetchall()
    conn.close()

    if not rows:
        raise HTTPException(400, "No approved polling stations to export")

    # Build CSV in memory
    output = io.StringIO()

    # Collect all field names from all rows to build headers
    all_field_names = set()
    stations_data = []
    for row in rows:
        form_data = json.loads(row["form_data"]) if row["form_data"] else {}
        all_field_names.update(form_data.keys())
        stations_data.append({
            "name": row["name"],
            "pages": json.loads(row["pages"]),
            "form_data": form_data,
        })

    # Remove internal metadata fields
    all_field_names = {f for f in all_field_names if not f.startswith("_")}

    # Sort field names for consistent column order
    sorted_fields = sorted(all_field_names)

    # Build header row: name, pages, then flattened form fields
    headers = ["name", "pages"]
    for field in sorted_fields:
        headers.append(f"{field}_type")
        headers.append(f"{field}_value")

    writer = csv.writer(output)
    writer.writerow(headers)

    # Write data rows
    for station in stations_data:
        row_data = [
            station["name"],
            ",".join(str(p + 1) for p in station["pages"]),  # 1-indexed page numbers
        ]
        for field in sorted_fields:
            field_data = station["form_data"].get(field, {})
            row_data.append(field_data.get("type", ""))
            row_data.append(field_data.get("value", "") if field_data.get("value") is not None else "")
        writer.writerow(row_data)

    csv_content = output.getvalue()
    output.close()

    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={
            "Content-Disposition": "attachment; filename=polling_stations.csv"
        }
    )


@app.delete("/api/sessions/{target_session_id}/comparison")
async def delete_comparison_data(target_session_id: str):
    """Delete all comparison (non-ECP) data for a session."""
    session = get_session(target_session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    if not session["comparison_source"]:
        raise HTTPException(400, "No comparison data to delete")

    conn = sqlite3.connect(DB_PATH)
    deleted = conn.execute(
        "DELETE FROM polling_station_queue WHERE session_id = ? AND source = ?",
        (target_session_id, session["comparison_source"])
    ).rowcount
    conn.execute(
        "UPDATE sessions SET comparison_source = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (target_session_id,)
    )
    conn.commit()
    conn.close()

    return {"status": "ok", "deleted": deleted}


@app.post("/api/sessions/{target_session_id}/comparison-upload")
async def upload_comparison_csv(target_session_id: str, file: UploadFile, source_name: str = Form(...)):
    """Upload a third-party CSV for comparison with ECP data."""
    session = get_session(target_session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    if not source_name or not source_name.strip():
        raise HTTPException(400, "Source name is required")
    source_name = source_name.strip()

    # Read and parse CSV
    import csv
    import io

    content = await file.read()
    text = content.decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))

    # Delete any existing comparison rows for this session+source
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "DELETE FROM polling_station_queue WHERE session_id = ? AND source = ?",
        (target_session_id, source_name)
    )

    # Parse CSV rows and insert
    inserted = 0
    for row in reader:
        name = row.get("name", "").strip()
        if not name:
            continue

        # Reconstruct form_data from _type/_value column pairs
        form_data = {}
        seen_fields = set()
        for col_name in row:
            if col_name.endswith("_type"):
                field = col_name[:-5]  # strip "_type"
                seen_fields.add(field)
            elif col_name.endswith("_value"):
                field = col_name[:-6]  # strip "_value"
                seen_fields.add(field)

        for field in seen_fields:
            type_val = row.get(f"{field}_type", "").strip()
            value_str = row.get(f"{field}_value", "").strip()
            if not type_val and not value_str:
                continue
            entry = {}
            if type_val:
                entry["type"] = type_val
            if value_str:
                try:
                    entry["value"] = int(value_str)
                except ValueError:
                    try:
                        entry["value"] = float(value_str)
                    except ValueError:
                        entry["value"] = value_str
            else:
                entry["value"] = None
            form_data[field] = entry

        conn.execute(
            "INSERT INTO polling_station_queue (session_id, name, pages, status, form_data, source) VALUES (?, ?, ?, 'approved', ?, ?)",
            (target_session_id, name, "[]", json.dumps(form_data), source_name)
        )
        inserted += 1

    # Update session comparison_source
    conn.execute(
        "UPDATE sessions SET comparison_source = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (source_name, target_session_id)
    )
    conn.commit()
    conn.close()

    return {"status": "ok", "source_name": source_name, "stations_inserted": inserted}


# --- Static files ---

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")
