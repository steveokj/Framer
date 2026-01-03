Connection Pooling Explained
Connection pooling is a technique where instead of opening/closing database connections for each query, you maintain a "pool" of reusable connections that stay open and get shared across multiple operations.
Without Connection Pooling (Inefficient):
python
Apply to video_utils....
import sqlite3
# Every query opens a new connection - SLOW!
def get_recent_frames():
    conn = sqlite3.connect("db.sqlite")  # Opens connection
    result = conn.execute("SELECT * FROM frames LIMIT 10").fetchall()
    conn.close()  # Closes connection
    return result
def get_audio_data():
    conn = sqlite3.connect("db.sqlite")  # Opens ANOTHER connection
    result = conn.execute("SELECT * FROM audio LIMIT 10").fetchall()
    conn.close()
    return result
With Connection Pooling (Efficient):
python
Apply to video_utils....
from sqlalchemy import create_engine
from sqlalchemy.pool import QueuePool
# Create a pool of 5-20 reusable connections
engine = create_engine(
    "sqlite:///db.sqlite",
    poolclass=QueuePool,
    pool_size=5,
    max_overflow=15
)
def get_recent_frames():
    # Reuses existing connection from pool
    with engine.connect() as conn:
        return conn.execute("SELECT * FROM frames LIMIT 10").fetchall()
def get_audio_data():
    # Reuses another connection from pool (no overhead!)
    with engine.connect() as conn:
        return conn.execute("SELECT * FROM audio LIMIT 10").fetchall()
Benefits:
Much faster - no connection setup/teardown overhead
Better resource management - limited number of connections
Handles concurrent requests - multiple queries can use different pooled connections
Querying Across 3 SQLite Databases Efficiently
You have an interesting multi-database setup! Here are several performant approaches:
Approach 1: ATTACH DATABASE (Recommended for Complex Queries)
SQLite allows you to attach multiple databases to a single connection and query them together:
python
Apply to video_utils....
import sqlite3
def setup_multi_db_connection():
    # Connect to primary database
    conn = sqlite3.connect("~/.screenpipe/db.sqlite", uri=True)
    
    # Attach other databases
    conn.execute("ATTACH DATABASE 'path/to/ahk_mouse_screen.db' AS ahk_db")
    conn.execute("ATTACH DATABASE 'path/to/python_audio.db' AS audio_db")
    
    return conn
def get_correlated_activity(start_time, end_time):
    conn = setup_multi_db_connection()
    
    # Query across all 3 databases in one SQL statement!
    query = """
    SELECT 
        s.timestamp as screen_time,
        s.app_name,
        s.window_name,
        a.mouse_x,
        a.mouse_y, 
        a.click_type,
        p.transcription
    FROM main.frames s
    LEFT JOIN ahk_db.mouse_events a 
        ON abs(julianday(s.timestamp) - julianday(a.timestamp)) < 0.0001  -- within ~8 seconds
    LEFT JOIN audio_db.transcriptions p
        ON abs(julianday(s.timestamp) - julianday(p.timestamp)) < 0.0035  -- within ~5 minutes
    WHERE julianday(s.timestamp) >= julianday(?)
      AND julianday(s.timestamp) <= julianday(?)
    ORDER BY s.timestamp DESC
    LIMIT 100
    """
    
    return conn.execute(query, (start_time, end_time)).fetchall()
Approach 2: Separate Connections with Smart Caching
python
Apply to video_utils....
import sqlite3
from datetime import datetime, timedelta
from typing import Dict, List
import threading
class MultiDBManager:
    def __init__(self):
        # Separate connection pools for each database
        self.screenpipe_conn = sqlite3.connect("~/.screenpipe/db.sqlite", uri=True, check_same_thread=False)
        self.ahk_conn = sqlite3.connect("path/to/ahk_mouse_screen.db", check_same_thread=False)
        self.audio_conn = sqlite3.connect("path/to/python_audio.db", check_same_thread=False)
        
        # Thread locks for safety
        self.locks = {
            'screenpipe': threading.Lock(),
            'ahk': threading.Lock(),
            'audio': threading.Lock()
        }
    
    def get_time_window_data(self, start_time: str, end_time: str) -> Dict:
        """Efficiently fetch data from all databases in parallel"""
        import concurrent.futures
        
        def get_screenpipe_data():
            with self.locks['screenpipe']:
                return self.screenpipe_conn.execute("""
                    SELECT timestamp, app_name, window_name, browser_url
                    FROM frames 
                    WHERE julianday(timestamp) >= julianday(?)
                      AND julianday(timestamp) <= julianday(?)
                    ORDER BY timestamp
                """, (start_time, end_time)).fetchall()
        
        def get_ahk_data():
            with self.locks['ahk']:
                return self.ahk_conn.execute("""
                    SELECT timestamp, mouse_x, mouse_y, click_type, key_pressed
                    FROM mouse_screen_events 
                    WHERE julianday(timestamp) >= julianday(?)
                      AND julianday(timestamp) <= julianday(?)
                    ORDER BY timestamp
                """, (start_time, end_time)).fetchall()
        
        def get_audio_data():
            with self.locks['audio']:
                return self.audio_conn.execute("""
                    SELECT timestamp, transcription, confidence
                    FROM transcriptions 
                    WHERE julianday(timestamp) >= julianday(?)
                      AND julianday(timestamp) <= julianday(?)
                    ORDER BY timestamp
                """, (start_time, end_time)).fetchall()
        
        # Execute all queries in parallel
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            future_screenpipe = executor.submit(get_screenpipe_data)
            future_ahk = executor.submit(get_ahk_data)
            future_audio = executor.submit(get_audio_data)
            
            return {
                'screenpipe': future_screenpipe.result(),
                'ahk': future_ahk.result(),
                'audio': future_audio.result()
            }
    
    def correlate_by_time(self, data: Dict, time_tolerance_seconds: int = 30):
        """Correlate data from all sources by timestamp"""
        correlated = []
        
        for sp_row in data['screenpipe']:
            sp_time = datetime.fromisoformat(sp_row[0])
            
            # Find closest AHK events
            closest_ahk = self._find_closest_by_time(
                data['ahk'], sp_time, time_tolerance_seconds
            )
            
            # Find closest audio transcription
            closest_audio = self._find_closest_by_time(
                data['audio'], sp_time, time_tolerance_seconds * 10  # Longer tolerance for audio
            )
            
            correlated.append({
                'screenpipe': sp_row,
                'ahk': closest_ahk,
                'audio': closest_audio,
                'correlation_time': sp_time
            })
        
        return correlated
    
    def _find_closest_by_time(self, data_list: List, target_time: datetime, tolerance_seconds: int):
        """Find the closest record by timestamp within tolerance"""
        closest = None
        min_diff = float('inf')
        
        for row in data_list:
            row_time = datetime.fromisoformat(row[0])
            diff = abs((target_time - row_time).total_seconds())
            
            if diff <= tolerance_seconds and diff < min_diff:
                min_diff = diff
                closest = row
        
        return closest
Approach 3: Materialized View Pattern (Best for Frequent Queries)
Create a separate "analytics" database that periodically syncs data from all three:
python
Apply to video_utils....
import sqlite3
import schedule
import time
class AnalyticsDB:
    def __init__(self):
        self.analytics_conn = sqlite3.connect("analytics.db")
        self.setup_analytics_tables()
    
    def setup_analytics_tables(self):
        """Create optimized tables for cross-database analytics"""
        self.analytics_conn.executescript("""
        CREATE TABLE IF NOT EXISTS activity_timeline (
            timestamp TEXT PRIMARY KEY,
            source_type TEXT,  -- 'screenpipe', 'ahk', 'audio'
            app_name TEXT,
            window_name TEXT,
            mouse_x INTEGER,
            mouse_y INTEGER,
            action_type TEXT,
            transcription TEXT,
            confidence REAL
        );
        
        CREATE INDEX IF NOT EXISTS idx_timeline_time ON activity_timeline(timestamp);
        CREATE INDEX IF NOT EXISTS idx_timeline_source ON activity_timeline(source_type);
        CREATE INDEX IF NOT EXISTS idx_timeline_app ON activity_timeline(app_name);
        """)
    
    def sync_data_from_sources(self):
        """Periodically sync data from all source databases"""
        # Get latest timestamp from analytics
        last_sync = self.analytics_conn.execute(
            "SELECT MAX(timestamp) FROM activity_timeline"
        ).fetchone()[0]
        
        if not last_sync:
            last_sync = datetime.now() - timedelta(days=1)
        
        # Sync from each source
        self._sync_screenpipe(last_sync)
        self._sync_ahk(last_sync)
        self._sync_audio(last_sync)
        
        self.analytics_conn.commit()
    
    def get_activity_summary(self, hours_back: int = 3):
        """Fast queries on pre-processed data"""
        return self.analytics_conn.execute("""
        SELECT 
            datetime(timestamp) as time,
            app_name,
            COUNT(*) as activity_count,
            GROUP_CONCAT(DISTINCT action_type) as actions,
            MAX(transcription) as sample_audio
        FROM activity_timeline
        WHERE julianday(timestamp) >= julianday('now', '-{} hours')
        GROUP BY datetime(timestamp, 'start of hour'), app_name
        ORDER BY timestamp DESC
        """.format(hours_back)).fetchall()
# Setup periodic sync
analytics = AnalyticsDB()
schedule.every(1).minutes.do(analytics.sync_data_from_sources)
# Run scheduler in background
def run_scheduler():
    while True:
        schedule.run_pending()
        time.sleep(60)
Performance Recommendations
For real-time queries: Use Approach 1 (ATTACH DATABASE)
For heavy analytics: Use Approach 3 (Materialized Views)
For simple separate queries: Use Approach 2 (Parallel connections)
Database Schema Recommendations for Your AHK2 DB:
sql
Apply to video_utils....
CREATE TABLE mouse_screen_events (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL, -- 'mouse_move', 'click', 'scroll', 'key_press'
    mouse_x INTEGER,
    mouse_y INTEGER,
    click_type TEXT, -- 'left', 'right', 'middle'
    key_pressed TEXT,
    window_title TEXT,
    process_name TEXT
);
CREATE INDEX idx_mouse_timestamp ON mouse_screen_events(timestamp);
CREATE INDEX idx_mouse_event_type ON mouse_screen_events(event_type);
This setup will give you extremely powerful cross-database analytics capabilities!