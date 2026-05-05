use rusqlite::{Connection, params, Result as SqliteResult};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use chrono::Utc;
use rand::Rng;

// ============================================================
// Data Models
// ============================================================

/// Represents a user in the system
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub email: String,
    #[serde(skip_serializing)]
    pub password_hash: String,
    pub role: String, // "admin" or "user"
    pub created_at: String,
}

/// Status of a job in the queue
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub fn as_str(&self) -> &str {
        match self {
            JobStatus::Queued => "queued",
            JobStatus::Running => "running",
            JobStatus::Completed => "completed",
            JobStatus::Failed => "failed",
            JobStatus::Cancelled => "cancelled",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "queued" => Some(JobStatus::Queued),
            "running" => Some(JobStatus::Running),
            "completed" => Some(JobStatus::Completed),
            "failed" => Some(JobStatus::Failed),
            "cancelled" => Some(JobStatus::Cancelled),
            _ => None,
        }
    }
}

/// Represents a job in the queue
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: i64,
    pub user_id: i64,
    pub username: String,  // Joined from users table
    pub name: String,
    pub msb_filename: String,
    pub mstar_version: String,
    pub resolved_version: Option<String>,  // Actual version used (e.g. "4.4.23"), set at launch
    pub gpu_ids: String,  // JSON array, e.g. "[0,1]"
    pub unified_memory: bool,  // Use CPU RAM (--unified-memory flag)
    pub status: String,
    pub priority: i32,
    pub pid: Option<i64>,
    pub submitted_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub working_directory: Option<String>,
    pub output_file: Option<String>,
    pub error_message: Option<String>,
    pub restart_from_job_id: Option<i64>,
    pub restart_options: Option<String>,  // JSON for future input.xml modifications
    pub copy_to_path: Option<String>,     // Optional path to copy results on completion
}

/// Represents an active session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub token: String,
    pub user_id: i64,
    pub created_at: String,
    pub expires_at: String,
}

// ============================================================
// Database Handle
// ============================================================

/// Thread-safe database handle using Arc<Mutex<Connection>>
pub type DbHandle = Arc<Mutex<Connection>>;

/// Generate a random session token (64 hex characters)
pub fn generate_token() -> String {
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..32).map(|_| rng.gen::<u8>()).collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Initialize the database connection and create tables
pub fn init_db(db_path: &Path) -> SqliteResult<DbHandle> {
    let conn = Connection::open(db_path)?;

    // Enable WAL mode for better concurrent read performance
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")?;

    // Create all tables
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            msb_filename TEXT NOT NULL,
            mstar_version TEXT NOT NULL DEFAULT 'latest',
            gpu_ids TEXT NOT NULL DEFAULT '[]',
            unified_memory INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'queued'
                CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
            priority INTEGER NOT NULL DEFAULT 0,
            pid INTEGER,
            submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
            started_at TEXT,
            completed_at TEXT,
            working_directory TEXT,
            output_file TEXT,
            error_message TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS gpu_reservations (
            gpu_id INTEGER NOT NULL,
            job_id INTEGER NOT NULL,
            reserved_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (gpu_id, job_id),
            FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
        CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
        "
    )?;

    // Migration: add restart columns if they don't exist yet
    let _ = conn.execute_batch(
        "ALTER TABLE jobs ADD COLUMN restart_from_job_id INTEGER REFERENCES jobs(id);"
    );
    let _ = conn.execute_batch(
        "ALTER TABLE jobs ADD COLUMN restart_options TEXT;"
    );

    // Migration: add copy_to_path column for auto-copy on completion
    let _ = conn.execute_batch(
        "ALTER TABLE jobs ADD COLUMN copy_to_path TEXT;"
    );

    // Migration: add resolved_version — tracks the actual M-Star version used (not "latest")
    let _ = conn.execute_batch(
        "ALTER TABLE jobs ADD COLUMN resolved_version TEXT;"
    );

    // Migration: user_gpu_access table for per-GPU permissions
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS user_gpu_access (
            user_id INTEGER NOT NULL,
            gpu_id  INTEGER NOT NULL,
            PRIMARY KEY (user_id, gpu_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );"
    );

    Ok(Arc::new(Mutex::new(conn)))
}

// ============================================================
// User Operations
// ============================================================

/// Validate that an email address belongs to the @latticept.com domain
pub fn validate_email(email: &str) -> Result<(), String> {
    let email_lower = email.to_lowercase();
    if !email_lower.contains('@') {
        return Err("Invalid email address".to_string());
    }
    if !email_lower.ends_with("@latticept.com") {
        return Err("Registration is restricted to @latticept.com email addresses".to_string());
    }
    Ok(())
}

/// Create a new user, returns the user ID
pub fn create_user(conn: &Connection, username: &str, email: &str, password: &str, role: &str) -> Result<i64, String> {
    // Validate email domain (skip for system-created admin)
    if role != "admin" || email != "admin@latticept.com" {
        validate_email(email)?;
    }

    let hash = bcrypt::hash(password, bcrypt::DEFAULT_COST)
        .map_err(|e| format!("Failed to hash password: {}", e))?;

    conn.execute(
        "INSERT INTO users (username, email, password_hash, role) VALUES (?1, ?2, ?3, ?4)",
        params![username, email, hash, role],
    ).map_err(|e| format!("Failed to create user: {}", e))?;

    Ok(conn.last_insert_rowid())
}

/// Verify user credentials, returns user if valid
pub fn authenticate_user(conn: &Connection, username: &str, password: &str) -> Result<User, String> {
    let user = conn.query_row(
        "SELECT id, username, email, password_hash, role, created_at FROM users WHERE username = ?1",
        params![username],
        |row| {
            Ok(User {
                id: row.get(0)?,
                username: row.get(1)?,
                email: row.get(2)?,
                password_hash: row.get(3)?,
                role: row.get(4)?,
                created_at: row.get(5)?,
            })
        },
    ).map_err(|_| "Invalid username or password".to_string())?;

    if bcrypt::verify(password, &user.password_hash)
        .map_err(|e| format!("Password verification failed: {}", e))? {
        Ok(user)
    } else {
        Err("Invalid username or password".to_string())
    }
}

/// Create a new session for a user, returns the session token
pub fn create_session(conn: &Connection, user_id: i64) -> Result<String, String> {
    let token = generate_token();
    let expires_at = (Utc::now() + chrono::Duration::hours(24)).format("%Y-%m-%d %H:%M:%S").to_string();

    conn.execute(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, ?2, ?3)",
        params![token, user_id, expires_at],
    ).map_err(|e| format!("Failed to create session: {}", e))?;

    Ok(token)
}

/// Validate a session token, returns the associated user
pub fn validate_session(conn: &Connection, token: &str) -> Result<User, String> {
    let user = conn.query_row(
        "SELECT u.id, u.username, u.email, u.password_hash, u.role, u.created_at
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.token = ?1 AND s.expires_at > datetime('now')",
        params![token],
        |row| {
            Ok(User {
                id: row.get(0)?,
                username: row.get(1)?,
                email: row.get(2)?,
                password_hash: row.get(3)?,
                role: row.get(4)?,
                created_at: row.get(5)?,
            })
        },
    ).map_err(|_| "Invalid or expired session".to_string())?;

    Ok(user)
}

/// Delete a session (logout)
pub fn delete_session(conn: &Connection, token: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM sessions WHERE token = ?1",
        params![token],
    ).map_err(|e| format!("Failed to delete session: {}", e))?;
    Ok(())
}

/// Delete expired sessions (maintenance)
pub fn cleanup_expired_sessions(conn: &Connection) -> Result<usize, String> {
    let count = conn.execute(
        "DELETE FROM sessions WHERE expires_at < datetime('now')",
        [],
    ).map_err(|e| format!("Failed to cleanup sessions: {}", e))?;
    Ok(count)
}

/// List all users (admin function)
pub fn list_users(conn: &Connection) -> Result<Vec<User>, String> {
    let mut stmt = conn.prepare(
        "SELECT id, username, email, password_hash, role, created_at FROM users ORDER BY id"
    ).map_err(|e| format!("Failed to prepare query: {}", e))?;

    let users = stmt.query_map([], |row| {
        Ok(User {
            id: row.get(0)?,
            username: row.get(1)?,
            email: row.get(2)?,
            password_hash: row.get(3)?,
            role: row.get(4)?,
            created_at: row.get(5)?,
        })
    }).map_err(|e| format!("Failed to query users: {}", e))?
    .filter_map(|r| r.ok())
    .collect();

    Ok(users)
}

/// Delete a user by ID
pub fn delete_user(conn: &Connection, user_id: i64) -> Result<(), String> {
    let changes = conn.execute(
        "DELETE FROM users WHERE id = ?1",
        params![user_id],
    ).map_err(|e| format!("Failed to delete user: {}", e))?;

    if changes == 0 {
        Err("User not found".to_string())
    } else {
        Ok(())
    }
}

/// Check if any admin user exists
pub fn has_admin(conn: &Connection) -> Result<bool, String> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM users WHERE role = 'admin'",
        [],
        |row| row.get(0),
    ).map_err(|e| format!("Failed to check for admin: {}", e))?;
    Ok(count > 0)
}

// ============================================================
// GPU Access Control
// ============================================================

/// Get the list of GPU IDs a user is allowed to access
pub fn get_user_gpu_access(conn: &Connection, user_id: i64) -> Result<Vec<i32>, String> {
    let mut stmt = conn.prepare(
        "SELECT gpu_id FROM user_gpu_access WHERE user_id = ?1 ORDER BY gpu_id"
    ).map_err(|e| format!("Failed to query GPU access: {}", e))?;

    let ids = stmt.query_map(params![user_id], |row| {
        row.get::<_, i32>(0)
    }).map_err(|e| format!("Failed to iterate GPU access: {}", e))?
    .filter_map(|r| r.ok())
    .collect();

    Ok(ids)
}

/// Set the allowed GPU IDs for a user (replaces existing access)
pub fn set_user_gpu_access(conn: &Connection, user_id: i64, gpu_ids: &[i32]) -> Result<(), String> {
    conn.execute(
        "DELETE FROM user_gpu_access WHERE user_id = ?1",
        params![user_id],
    ).map_err(|e| format!("Failed to clear GPU access: {}", e))?;

    for &gpu_id in gpu_ids {
        conn.execute(
            "INSERT INTO user_gpu_access (user_id, gpu_id) VALUES (?1, ?2)",
            params![user_id, gpu_id],
        ).map_err(|e| format!("Failed to set GPU access: {}", e))?;
    }

    Ok(())
}

/// Update a user's role
pub fn update_user_role(conn: &Connection, user_id: i64, role: &str) -> Result<(), String> {
    if role != "admin" && role != "user" {
        return Err("Invalid role. Must be 'admin' or 'user'.".to_string());
    }
    let changes = conn.execute(
        "UPDATE users SET role = ?2 WHERE id = ?1",
        params![user_id, role],
    ).map_err(|e| format!("Failed to update user role: {}", e))?;

    if changes == 0 {
        Err("User not found".to_string())
    } else {
        Ok(())
    }
}

/// Admin creates a new user with specified role and GPU access
pub fn create_user_by_admin(
    conn: &Connection,
    username: &str,
    email: &str,
    password: &str,
    role: &str,
    gpu_ids: &[i32],
) -> Result<i64, String> {
    if role != "admin" && role != "user" {
        return Err("Invalid role. Must be 'admin' or 'user'.".to_string());
    }

    let password_hash = bcrypt::hash(password, 10)
        .map_err(|e| format!("Failed to hash password: {}", e))?;

    conn.execute(
        "INSERT INTO users (username, email, password_hash, role) VALUES (?1, ?2, ?3, ?4)",
        params![username, email, password_hash, role],
    ).map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            "Username or email already exists".to_string()
        } else {
            format!("Failed to create user: {}", e)
        }
    })?;

    let user_id = conn.last_insert_rowid();

    // Set GPU access
    set_user_gpu_access(conn, user_id, gpu_ids)?;

    Ok(user_id)
}

// ============================================================
// Job Operations
// ============================================================

/// Create a new job in the queue
pub fn create_job(
    conn: &Connection,
    user_id: i64,
    name: &str,
    msb_filename: &str,
    mstar_version: &str,
    gpu_ids: &str,
    unified_memory: bool,
    priority: i32,
    copy_to_path: Option<&str>,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO jobs (user_id, name, msb_filename, mstar_version, gpu_ids, unified_memory, priority, copy_to_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![user_id, name, msb_filename, mstar_version, gpu_ids, unified_memory as i32, priority, copy_to_path],
    ).map_err(|e| format!("Failed to create job: {}", e))?;

    Ok(conn.last_insert_rowid())
}

/// List jobs with optional status filter
pub fn list_jobs(conn: &Connection, status_filter: Option<&str>, limit: Option<i64>) -> Result<Vec<Job>, String> {
    let limit_val = limit.unwrap_or(100);

    let (query, params_vec): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = if let Some(status) = status_filter {
        (
            "SELECT j.id, j.user_id, COALESCE(u.username, 'unknown') as username, j.name, j.msb_filename,
                    j.mstar_version, j.gpu_ids, j.unified_memory, j.status, j.priority, j.pid,
                    j.submitted_at, j.started_at, j.completed_at, j.working_directory,
                    j.output_file, j.error_message, j.restart_from_job_id, j.restart_options,
                    j.copy_to_path, j.resolved_version
             FROM jobs j LEFT JOIN users u ON j.user_id = u.id
             WHERE j.status = ?1
             ORDER BY j.priority DESC, j.submitted_at ASC
             LIMIT ?2".to_string(),
            vec![Box::new(status.to_string()), Box::new(limit_val)]
        )
    } else {
        (
            "SELECT j.id, j.user_id, COALESCE(u.username, 'unknown') as username, j.name, j.msb_filename,
                    j.mstar_version, j.gpu_ids, j.unified_memory, j.status, j.priority, j.pid,
                    j.submitted_at, j.started_at, j.completed_at, j.working_directory,
                    j.output_file, j.error_message, j.restart_from_job_id, j.restart_options,
                    j.copy_to_path, j.resolved_version
             FROM jobs j LEFT JOIN users u ON j.user_id = u.id
             ORDER BY j.submitted_at DESC
             LIMIT ?1".to_string(),
            vec![Box::new(limit_val)]
        )
    };

    let mut stmt = conn.prepare(&query)
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

    let jobs = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(Job {
            id: row.get(0)?,
            user_id: row.get(1)?,
            username: row.get(2)?,
            name: row.get(3)?,
            msb_filename: row.get(4)?,
            mstar_version: row.get(5)?,
            gpu_ids: row.get(6)?,
            unified_memory: row.get::<_, i32>(7)? != 0,
            status: row.get(8)?,
            priority: row.get(9)?,
            pid: row.get(10)?,
            submitted_at: row.get(11)?,
            started_at: row.get(12)?,
            completed_at: row.get(13)?,
            working_directory: row.get(14)?,
            output_file: row.get(15)?,
            error_message: row.get(16)?,
            restart_from_job_id: row.get(17)?,
            restart_options: row.get(18)?,
            copy_to_path: row.get(19)?,
            resolved_version: row.get(20)?,
        })
    }).map_err(|e| format!("Failed to query jobs: {}", e))?
    .filter_map(|r| r.ok())
    .collect();

    Ok(jobs)
}

/// Get a single job by ID
pub fn get_job(conn: &Connection, job_id: i64) -> Result<Job, String> {
    conn.query_row(
        "SELECT j.id, j.user_id, COALESCE(u.username, 'unknown') as username, j.name, j.msb_filename,
                j.mstar_version, j.gpu_ids, j.unified_memory, j.status, j.priority, j.pid,
                j.submitted_at, j.started_at, j.completed_at, j.working_directory,
                j.output_file, j.error_message, j.restart_from_job_id, j.restart_options,
                j.copy_to_path, j.resolved_version
         FROM jobs j LEFT JOIN users u ON j.user_id = u.id
         WHERE j.id = ?1",
        params![job_id],
        |row| {
            Ok(Job {
                id: row.get(0)?,
                user_id: row.get(1)?,
                username: row.get(2)?,
                name: row.get(3)?,
                msb_filename: row.get(4)?,
                mstar_version: row.get(5)?,
                gpu_ids: row.get(6)?,
                unified_memory: row.get::<_, i32>(7)? != 0,
                status: row.get(8)?,
                priority: row.get(9)?,
                pid: row.get(10)?,
                submitted_at: row.get(11)?,
                started_at: row.get(12)?,
                completed_at: row.get(13)?,
                working_directory: row.get(14)?,
                output_file: row.get(15)?,
                error_message: row.get(16)?,
                restart_from_job_id: row.get(17)?,
                restart_options: row.get(18)?,
                copy_to_path: row.get(19)?,
                resolved_version: row.get(20)?,
            })
        },
    ).map_err(|_| format!("Job {} not found", job_id))
}

/// Update job status to running (with PID, working dir, output file)
pub fn start_job(
    conn: &Connection,
    job_id: i64,
    pid: u32,
    working_directory: &str,
    output_file: &str,
) -> Result<(), String> {
    let changes = conn.execute(
        "UPDATE jobs SET status = 'running', pid = ?2, started_at = datetime('now'),
         working_directory = ?3, output_file = ?4
         WHERE id = ?1 AND status = 'queued'",
        params![job_id, pid as i64, working_directory, output_file],
    ).map_err(|e| format!("Failed to start job: {}", e))?;

    if changes == 0 {
        Err(format!("Job {} not found or not in queued state", job_id))
    } else {
        // Reserve GPUs for this job
        let job = get_job(conn, job_id)?;
        let gpu_ids: Vec<i32> = serde_json::from_str(&job.gpu_ids).unwrap_or_default();
        for gpu_id in gpu_ids {
            conn.execute(
                "INSERT OR REPLACE INTO gpu_reservations (gpu_id, job_id) VALUES (?1, ?2)",
                params![gpu_id, job_id],
            ).map_err(|e| format!("Failed to reserve GPU {}: {}", gpu_id, e))?;
        }
        Ok(())
    }
}

/// Mark a job as completed
pub fn complete_job(conn: &Connection, job_id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE jobs SET status = 'completed', completed_at = datetime('now'), pid = NULL
         WHERE id = ?1 AND status = 'running'",
        params![job_id],
    ).map_err(|e| format!("Failed to complete job: {}", e))?;

    // Release GPU reservations
    conn.execute(
        "DELETE FROM gpu_reservations WHERE job_id = ?1",
        params![job_id],
    ).map_err(|e| format!("Failed to release GPU reservations: {}", e))?;

    Ok(())
}

/// Mark a job as failed with an error message
pub fn fail_job(conn: &Connection, job_id: i64, error: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE jobs SET status = 'failed', completed_at = datetime('now'), pid = NULL,
         error_message = ?2
         WHERE id = ?1 AND (status = 'running' OR status = 'queued')",
        params![job_id, error],
    ).map_err(|e| format!("Failed to mark job as failed: {}", e))?;

    // Release GPU reservations
    conn.execute(
        "DELETE FROM gpu_reservations WHERE job_id = ?1",
        params![job_id],
    ).map_err(|e| format!("Failed to release GPU reservations: {}", e))?;

    Ok(())
}

/// Cancel a job
pub fn cancel_job(conn: &Connection, job_id: i64) -> Result<Option<i64>, String> {
    // Get PID before cancelling (needed to kill the process)
    let pid: Option<i64> = conn.query_row(
        "SELECT pid FROM jobs WHERE id = ?1 AND (status = 'queued' OR status = 'running')",
        params![job_id],
        |row| row.get(0),
    ).map_err(|_| format!("Job {} not found or already finished", job_id))?;

    conn.execute(
        "UPDATE jobs SET status = 'cancelled', completed_at = datetime('now'), pid = NULL
         WHERE id = ?1 AND (status = 'queued' OR status = 'running')",
        params![job_id],
    ).map_err(|e| format!("Failed to cancel job: {}", e))?;

    // Release GPU reservations
    conn.execute(
        "DELETE FROM gpu_reservations WHERE job_id = ?1",
        params![job_id],
    ).map_err(|e| format!("Failed to release GPU reservations: {}", e))?;

    Ok(pid)
}

/// Get next queued job (ordered by priority descending, then submission time ascending)
pub fn get_next_queued_job(conn: &Connection) -> Result<Option<Job>, String> {
    let result = conn.query_row(
        "SELECT j.id, j.user_id, COALESCE(u.username, 'unknown') as username, j.name, j.msb_filename,
                j.mstar_version, j.gpu_ids, j.unified_memory, j.status, j.priority, j.pid,
                j.submitted_at, j.started_at, j.completed_at, j.working_directory,
                j.output_file, j.error_message, j.restart_from_job_id, j.restart_options,
                j.copy_to_path, j.resolved_version
         FROM jobs j LEFT JOIN users u ON j.user_id = u.id
         WHERE j.status = 'queued'
         ORDER BY j.priority DESC, j.submitted_at ASC
         LIMIT 1",
        [],
        |row| {
            Ok(Job {
                id: row.get(0)?,
                user_id: row.get(1)?,
                username: row.get(2)?,
                name: row.get(3)?,
                msb_filename: row.get(4)?,
                mstar_version: row.get(5)?,
                gpu_ids: row.get(6)?,
                unified_memory: row.get::<_, i32>(7)? != 0,
                status: row.get(8)?,
                priority: row.get(9)?,
                pid: row.get(10)?,
                submitted_at: row.get(11)?,
                started_at: row.get(12)?,
                completed_at: row.get(13)?,
                working_directory: row.get(14)?,
                output_file: row.get(15)?,
                error_message: row.get(16)?,
                restart_from_job_id: row.get(17)?,
                restart_options: row.get(18)?,
                copy_to_path: row.get(19)?,
                resolved_version: row.get(20)?,
            })
        },
    );

    match result {
        Ok(job) => Ok(Some(job)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("Failed to get next queued job: {}", e)),
    }
}

/// Get all currently reserved GPU IDs
pub fn get_reserved_gpus(conn: &Connection) -> Result<Vec<i32>, String> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT gpu_id FROM gpu_reservations"
    ).map_err(|e| format!("Failed to query GPU reservations: {}", e))?;

    let gpus = stmt.query_map([], |row| {
        row.get::<_, i32>(0)
    }).map_err(|e| format!("Failed to read GPU reservations: {}", e))?
    .filter_map(|r| r.ok())
    .collect();

    Ok(gpus)
}

/// Mark stale running jobs as failed on daemon restart
pub fn recover_stale_jobs(conn: &Connection) -> Result<usize, String> {
    let changes = conn.execute(
        "UPDATE jobs SET status = 'failed', completed_at = datetime('now'), pid = NULL,
         error_message = 'Daemon restarted while job was running'
         WHERE status = 'running'",
        [],
    ).map_err(|e| format!("Failed to recover stale jobs: {}", e))?;

    // Clear all GPU reservations (will be re-established when jobs start)
    conn.execute("DELETE FROM gpu_reservations", [])
        .map_err(|e| format!("Failed to clear GPU reservations: {}", e))?;

    Ok(changes)
}

/// Get all jobs currently marked as running (for daemon restart recovery)
pub fn get_running_jobs(conn: &Connection) -> Result<Vec<Job>, String> {
    let mut stmt = conn.prepare(
        "SELECT j.id, j.user_id, COALESCE(u.username, 'unknown') as username, j.name, j.msb_filename,
                j.mstar_version, j.gpu_ids, j.unified_memory, j.status, j.priority, j.pid,
                j.submitted_at, j.started_at, j.completed_at, j.working_directory,
                j.output_file, j.error_message, j.restart_from_job_id, j.restart_options,
                j.copy_to_path, j.resolved_version
         FROM jobs j LEFT JOIN users u ON j.user_id = u.id
         WHERE j.status = 'running'"
    ).map_err(|e| format!("Failed to prepare query: {}", e))?;

    let jobs = stmt.query_map([], |row| {
        Ok(Job {
            id: row.get(0)?,
            user_id: row.get(1)?,
            username: row.get(2)?,
            name: row.get(3)?,
            msb_filename: row.get(4)?,
            mstar_version: row.get(5)?,
            gpu_ids: row.get(6)?,
            unified_memory: row.get::<_, i32>(7)? != 0,
            status: row.get(8)?,
            priority: row.get(9)?,
            pid: row.get(10)?,
            submitted_at: row.get(11)?,
            started_at: row.get(12)?,
            completed_at: row.get(13)?,
            working_directory: row.get(14)?,
            output_file: row.get(15)?,
            error_message: row.get(16)?,
            restart_from_job_id: row.get(17)?,
            restart_options: row.get(18)?,
            copy_to_path: row.get(19)?,
            resolved_version: row.get(20)?,
        })
    }).map_err(|e| format!("Failed to query running jobs: {}", e))?;

    jobs.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to collect running jobs: {}", e))
}

/// Mark a specific running job as failed (used during daemon restart recovery for dead processes)
pub fn fail_stale_job(conn: &Connection, job_id: i64, error: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE jobs SET status = 'failed', completed_at = datetime('now'), pid = NULL,
         error_message = ?2
         WHERE id = ?1 AND status = 'running'",
        params![job_id, error],
    ).map_err(|e| format!("Failed to fail stale job {}: {}", job_id, e))?;

    // Release GPU reservations for this job
    conn.execute(
        "DELETE FROM gpu_reservations WHERE job_id = ?1",
        params![job_id],
    ).map_err(|e| format!("Failed to release GPU reservations for job {}: {}", job_id, e))?;

    Ok(())
}

/// Get count of jobs by status
pub fn get_job_counts(conn: &Connection) -> Result<std::collections::HashMap<String, i64>, String> {
    let mut stmt = conn.prepare(
        "SELECT status, COUNT(*) FROM jobs GROUP BY status"
    ).map_err(|e| format!("Failed to count jobs: {}", e))?;

    let mut counts = std::collections::HashMap::new();
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    }).map_err(|e| format!("Failed to read job counts: {}", e))?;

    for row in rows {
        if let Ok((status, count)) = row {
            counts.insert(status, count);
        }
    }

    Ok(counts)
}

/// Ensure a default admin user exists (for first-time setup)
pub fn ensure_default_admin(conn: &Connection) -> Result<(), String> {
    if !has_admin(conn)? {
        create_user(conn, "admin", "admin@latticept.com", "admin", "admin")?;
        println!("[SETUP] Created default admin user (username: admin, password: admin)");
        println!("[SETUP] !! CHANGE THE DEFAULT PASSWORD IMMEDIATELY !!");
    }
    Ok(())
}

/// Create a restart job from a failed job.
/// The new job reuses the same working directory and config but uses --load-last on launch.
pub fn create_restart_job(
    conn: &Connection,
    original_job_id: i64,
    restart_options: Option<&str>,
) -> Result<i64, String> {
    // Fetch the original job
    let orig = get_job(conn, original_job_id)?;

    if orig.status != "failed" && orig.status != "cancelled" {
        return Err(format!("Can only restart failed/cancelled jobs (current status: {})", orig.status));
    }

    let restart_opts_val = restart_options.unwrap_or("{}");

    conn.execute(
        "INSERT INTO jobs (user_id, name, msb_filename, mstar_version, gpu_ids, unified_memory,
                           status, priority, restart_from_job_id, restart_options)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, ?8, ?9)",
        params![
            orig.user_id,
            format!("{} (restart)", orig.name),
            orig.msb_filename,
            orig.resolved_version.as_deref().unwrap_or(&orig.mstar_version),
            orig.gpu_ids,
            orig.unified_memory as i32,
            orig.priority,
            original_job_id,
            restart_opts_val,
        ],
    ).map_err(|e| format!("Failed to create restart job: {}", e))?;

    Ok(conn.last_insert_rowid())
}

/// Store the actual M-Star version used when launching a job.
/// This is critical for checkpoint restarts — ensures the same binary is used.
pub fn update_resolved_version(conn: &Connection, job_id: i64, version: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE jobs SET resolved_version = ?1 WHERE id = ?2",
        params![version, job_id],
    ).map_err(|e| format!("Failed to update resolved version: {}", e))?;
    Ok(())
}
