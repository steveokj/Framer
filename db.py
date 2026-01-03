import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional, Tuple

from path_utils import canonicalize_path

# ISO 8601 format for consistent timestamp formatting across the application
ISO_FMT = "%Y-%m-%dT%H:%M:%S%z"


# Returns the current UTC time as an ISO-formatted string
# Used for timestamping database records with consistent timezone info
def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime(ISO_FMT)


class TranscriptionDB:
    # Initializes the transcription database with optimized SQLite settings
    # Sets up WAL mode for better concurrency and enables foreign key constraints
    def __init__(self, db_path: str = "transcriptions.sqlite3") -> None:
        self.db_path = str(db_path)
        # Ensure parent directory exists for the database file
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        # Connect to SQLite database (allow multi-threaded access)
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        # Enable foreign key constraints for referential integrity
        self.conn.execute("PRAGMA foreign_keys = ON;")
        # Use Write-Ahead Logging for better concurrent read/write performance
        self.conn.execute("PRAGMA journal_mode = WAL;")
        # Use NORMAL synchronous mode for balance between safety and performance
        self.conn.execute("PRAGMA synchronous = NORMAL;")
        # Create tables and indexes if they don't exist
        self.init_schema()

    # Creates or updates the database schema with tables, triggers, and FTS indexes
    # Handles migration from legacy schemas if needed
    def init_schema(self) -> None:
        cur = self.conn.cursor()
        # Sessions table stores metadata for each recording session
        # One row per start/stop cycle with device info and model used
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS audio_sessions (
                id INTEGER PRIMARY KEY,
                title TEXT,
                file_path TEXT,
                device TEXT,
                sample_rate INTEGER,
                channels INTEGER,
                model TEXT,
                start_time TEXT NOT NULL,
                end_time TEXT,
                status TEXT DEFAULT 'active'
            );
            """
        )

        # Transcriptions table stores normalized text cached by canonical file path
        # Enables deduplicated lookups shared between realtime + batch workflows
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS audio_transcriptions (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                model_size TEXT NOT NULL,
                transcription TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(name, model_size)
            );
            """
        )

        # Check if migration from legacy schema is needed
        # This preserves data when upgrading from older versions
        self._maybe_migrate_transcriptions(cur)

        # FTS5 virtual table enables fast full-text search on transcriptions
        # Uses external content table to avoid duplicating data
        cur.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS audio_transcriptions_fts
            USING fts5(transcription, content='audio_transcriptions', content_rowid='id');
            """
        )

        # Trigger to automatically sync new transcriptions to the FTS index
        # Fires after each INSERT on audio_transcriptions table
        cur.execute(
            """
            CREATE TRIGGER IF NOT EXISTS audio_transcriptions_ai
            AFTER INSERT ON audio_transcriptions BEGIN
                INSERT INTO audio_transcriptions_fts(rowid, transcription)
                VALUES (new.id, new.transcription);
            END;
            """
        )

        # Trigger to remove deleted transcriptions from FTS index
        # Keeps FTS index in sync when rows are deleted
        cur.execute(
            """
            CREATE TRIGGER IF NOT EXISTS audio_transcriptions_ad
            AFTER DELETE ON audio_transcriptions BEGIN
                INSERT INTO audio_transcriptions_fts(audio_transcriptions_fts, rowid, transcription)
                VALUES('delete', old.id, old.transcription);
            END;
            """
        )

        # Trigger to update FTS index when transcriptions are modified
        # Deletes old entry and inserts updated one
        cur.execute(
            """
            CREATE TRIGGER IF NOT EXISTS audio_transcriptions_au
            AFTER UPDATE ON audio_transcriptions BEGIN
                INSERT INTO audio_transcriptions_fts(audio_transcriptions_fts, rowid, transcription)
                VALUES('delete', old.id, old.transcription);
                INSERT INTO audio_transcriptions_fts(rowid, transcription)
                VALUES (new.id, new.transcription);
            END;
            """
        )

        self._rebuild_fts_if_needed(cur)

        self.conn.commit()

    # Creates a new audio recording session in the database
    # Returns the session ID for linking transcriptions later
    # Automatically sets start_time to current UTC timestamp
    def create_session(
        self,
        *,
        title: Optional[str] = None,
        file_path: Optional[str] = None,
        device: Optional[str] = None,
        sample_rate: Optional[int] = None,
        channels: Optional[int] = None,
        model: Optional[str] = None,
    ) -> int:
        cur = self.conn.cursor()
        cur.execute(
            """
            INSERT INTO audio_sessions (title, file_path, device, sample_rate, channels, model, start_time)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (title, file_path, device, sample_rate, channels, model, utc_now_iso()),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    # Marks a session as ended with the current timestamp
    # Allows setting custom status (e.g., 'completed', 'cancelled', 'error')
    def end_session(self, session_id: int, *, status: str = 'completed') -> None:
        self.conn.execute(
            "UPDATE audio_sessions SET end_time = ?, status = ? WHERE id = ?",
            (utc_now_iso(), status, session_id),
        )
        self.conn.commit()

    # Updates the file path for a session
    # Useful when the file path is determined after session creation
    def set_session_file(self, session_id: int, file_path: str) -> None:
        self.conn.execute(
            "UPDATE audio_sessions SET file_path = ? WHERE id = ?",
            (file_path, session_id),
        )
        self.conn.commit()

    # Upserts a transcription record keyed by canonicalized name + model size
    # Automatically triggers the FTS index update via database trigger
    # Returns the row id corresponding to the affected record
    def insert_transcription(
        self,
        *,
        name: str,
        model_size: str,
        transcription: str,
        created_at: Optional[str] = None,
    ) -> int:
        if not created_at:
            created_at = utc_now_iso()
        cur = self.conn.cursor()
        cur.execute(
            """
            INSERT INTO audio_transcriptions (name, model_size, transcription, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(name, model_size)
            DO UPDATE SET
                transcription = excluded.transcription,
                created_at = excluded.created_at
            """,
            (
                canonicalize_path(name),
                model_size,
                transcription,
                created_at,
            ),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    # Closes the database connection gracefully
    # Ignores any errors during close (defensive cleanup)
    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:
            pass

    # --- internal helpers ---

    def _rebuild_fts_if_needed(self, cur: sqlite3.Cursor) -> None:
        try:
            has_fts = cur.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='audio_transcriptions_fts' LIMIT 1"
            ).fetchone()
            if not has_fts:
                return
            total = cur.execute("SELECT COUNT(*) FROM audio_transcriptions").fetchone()[0]
            if total == 0:
                return
            fts_total = cur.execute("SELECT COUNT(*) FROM audio_transcriptions_fts").fetchone()[0]
            if fts_total == 0:
                cur.execute("INSERT INTO audio_transcriptions_fts(audio_transcriptions_fts) VALUES('rebuild')")
        except Exception:
            pass
    
    # Migrates legacy database schemas to the current format
    # Checks column structure and rebuilds table if needed
    # Preserves data during migration
    def _maybe_migrate_transcriptions(self, cur: sqlite3.Cursor) -> None:
        try:
            cur.execute("PRAGMA table_info(audio_transcriptions)")
            cols = [r[1] for r in cur.fetchall()]
        except Exception:
            return

        new_cols = ["id", "name", "model_size", "transcription", "created_at"]
        if not cols:
            return
        # If columns already match, skip
        if cols == new_cols:
            return
        # If there are legacy columns, migrate
        # Drop FTS/triggers first (if exist)
        cur.execute("DROP TRIGGER IF EXISTS audio_transcriptions_ai")
        cur.execute("DROP TRIGGER IF EXISTS audio_transcriptions_ad")
        cur.execute("DROP TRIGGER IF EXISTS audio_transcriptions_au")
        cur.execute("DROP TABLE IF EXISTS audio_transcriptions_fts")

        # Create new table
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS audio_transcriptions_new (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                model_size TEXT NOT NULL,
                transcription TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(name, model_size)
            );
            """
        )

        if cols == ["id", "canonical_path", "model_size", "transcription", "created_at"]:
            cur.execute(
                """
                INSERT INTO audio_transcriptions_new (id, name, model_size, transcription, created_at)
                SELECT id, canonical_path, model_size, transcription, created_at
                FROM audio_transcriptions
                """
            )
        else:
            # Copy and adapt legacy rows that referenced sessions
            legacy_rows = cur.execute(
                """
                SELECT
                    at.id,
                    at.session_id,
                    at.transcription,
                    at.timestamp,
                    s.file_path,
                    s.model
                FROM audio_transcriptions AS at
                LEFT JOIN audio_sessions AS s ON s.id = at.session_id
                ORDER BY at.id
                """
            ).fetchall()

            dedup: Dict[Tuple[str, str], Tuple[int, str, str]] = {}
            for row in legacy_rows:
                row_id, session_id, text, ts, file_path, model = row
                name = None
                if file_path:
                    name = canonicalize_path(file_path)
                elif session_id is not None:
                    name = f"session:{session_id}"
                else:
                    name = f"row:{row_id}"

                model_str = (model or "").strip()
                if ":" in model_str:
                    model_tail = model_str.split(":", 1)[1]
                else:
                    model_tail = model_str
                if "/" in model_tail:
                    candidate = model_tail.split("/", 1)[0].strip()
                    model_size = candidate or "unknown"
                else:
                    model_size = model_tail or "unknown"
                created_at = ts or utc_now_iso()

                key = (name, model_size)
                existing = dedup.get(key)
                if existing is None or created_at >= existing[2]:
                    dedup[key] = (row_id, text, created_at)

            for (name, model_size), (row_id, text, created_at) in dedup.items():
                cur.execute(
                    """
                    INSERT INTO audio_transcriptions_new (id, name, model_size, transcription, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (row_id, name, model_size, text, created_at),
                )

        # Replace table
        cur.execute("DROP TABLE audio_transcriptions")
        cur.execute("ALTER TABLE audio_transcriptions_new RENAME TO audio_transcriptions")
