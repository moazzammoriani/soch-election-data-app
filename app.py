import json
import uuid
import sqlite3
import time
import asyncio
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager

import fitz
from fastapi import FastAPI, UploadFile, HTTPException, Cookie, Response as FastAPIResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, ConfigDict, create_model
from google import genai
from enum import Enum


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
        if key in ("processed_pages", "schema_fields", "pending_pages", "pending_form_data"):
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


# Global rate limiter: 10 req/sec = 600 RPM (safe margin under 1k RPM limit)
gemini_rate_limiter = RateLimiter(max_per_second=10)


async def call_gemini_with_retry(contents, response_schema, max_retries: int = 3):
    """Call Gemini API with retry logic for rate limit errors."""
    from google.genai.errors import ClientError

    for attempt in range(max_retries):
        await gemini_rate_limiter.acquire()
        try:
            response = gemini_client.models.generate_content(
                model="gemini-3-flash-preview",
                contents=contents,
                config=genai.types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=response_schema,
                ),
            )
            return response
        except ClientError as e:
            if e.status_code == 429 and attempt < max_retries - 1:
                # Extract retry delay from error if available, otherwise use exponential backoff
                retry_delay = 30 * (2 ** attempt)  # 30s, 60s, 120s
                await asyncio.sleep(retry_delay)
            else:
                raise


# --- Gemini client (singleton) ---

gemini_client = genai.Client()


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


class ProcessRequest(BaseModel):
    pages: list[int]


class ApproveRequest(BaseModel):
    pages: list[int]
    form_data: dict


class CreatePollingStationRequest(BaseModel):
    pages: list[int]


class ApprovePollingStationRequest(BaseModel):
    form_data: dict


class RenamePollingStationRequest(BaseModel):
    name: str


# --- Endpoints ---

def get_session_step(session: dict) -> str:
    """Determine the current step for a session."""
    if not session["pdf_name"]:
        return "upload"
    if not session["schema_fields"]:
        return "schema"
    if session["page_count"] > 0 and len(session["processed_pages"]) >= session["page_count"]:
        return "complete"
    return "process"


@app.get("/api/sessions")
async def list_sessions():
    """List all sessions for dashboard."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM sessions ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()

    sessions = []
    for row in rows:
        session = {
            "id": row["id"],
            "pdf_name": row["pdf_name"],
            "page_count": row["page_count"],
            "processed_pages": json.loads(row["processed_pages"]),
            "candidate_1_name": row["candidate_1_name"],
            "candidate_2_name": row["candidate_2_name"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
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
        }
    }


@app.post("/api/session/reset")
async def reset_session(response: FastAPIResponse, session_id: Optional[str] = Cookie(default=None)):
    """Clear current session and start fresh."""
    if session_id:
        delete_session(session_id)

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
    contents = [prompt]
    for img_bytes in images:
        contents.append(
            genai.types.Part.from_bytes(data=img_bytes, mime_type="image/png")
        )

    # Call Gemini with rate limiting and retry
    response = await call_gemini_with_retry(contents, DynamicForm)

    # Parse and return
    result = DynamicForm.model_validate_json(response.text)
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

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM polling_station_queue WHERE session_id = ? ORDER BY id ASC",
        (session_id,)
    ).fetchall()
    conn.close()

    result = {"pending": [], "processed": [], "approved": []}
    for r in rows:
        item = {
            "id": r["id"],
            "name": r["name"],
            "pages": json.loads(r["pages"]),
            "status": r["status"],
            "form_data": json.loads(r["form_data"]) if r["form_data"] else None,
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


@app.get("/api/polling-station/{station_id}")
async def get_polling_station(station_id: int, session_id: Optional[str] = Cookie(default=None)):
    """Get a specific polling station's details."""
    if not session_id:
        raise HTTPException(400, "No session")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT * FROM polling_station_queue WHERE id = ? AND session_id = ?",
        (station_id, session_id)
    ).fetchone()
    conn.close()

    if not row:
        raise HTTPException(404, "Polling station not found")

    return {
        "id": row["id"],
        "name": row["name"],
        "pages": json.loads(row["pages"]),
        "status": row["status"],
        "form_data": json.loads(row["form_data"]) if row["form_data"] else None,
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


async def process_single_station(session_id: str, station_id: int) -> dict:
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

    # Extract page images
    doc = fitz.open(session["pdf_path"])
    images = []
    for page_num in pages:
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
    contents = [prompt]
    for img_bytes in images:
        contents.append(
            genai.types.Part.from_bytes(data=img_bytes, mime_type="image/png")
        )

    # Call Gemini with rate limiting and retry
    response = await call_gemini_with_retry(contents, DynamicForm)

    # Parse result
    result = DynamicForm.model_validate_json(response.text)
    form_data = result.model_dump()

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
async def process_polling_station(station_id: int, session_id: Optional[str] = Cookie(default=None)):
    """Process a single polling station with Gemini."""
    if not session_id:
        raise HTTPException(400, "No session")

    return await process_single_station(session_id, station_id)


@app.post("/api/polling-stations/batch-process")
async def batch_process_polling_stations(session_id: Optional[str] = Cookie(default=None)):
    """Process all pending polling stations with rate limiting."""
    if not session_id:
        raise HTTPException(400, "No session")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id FROM polling_station_queue WHERE session_id = ? AND status = 'pending'",
        (session_id,)
    ).fetchall()
    conn.close()

    if not rows:
        return {"processed": [], "errors": []}

    station_ids = [r["id"] for r in rows]

    # Process all in parallel
    tasks = [process_single_station(session_id, sid) for sid in station_ids]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    processed = []
    errors = []
    for sid, result in zip(station_ids, results):
        if isinstance(result, Exception):
            errors.append({"id": sid, "error": str(result)})
        else:
            processed.append(result)

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


# --- Static files ---

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")
