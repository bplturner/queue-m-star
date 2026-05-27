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
    pub archived: bool,                    // Whether this job is archived (hidden from default views)
    pub job_type: String,                  // "simulation" or "render"
    pub source_job_id: Option<i64>,        // For render jobs: ID of the simulation job being rendered
    pub sweep_group_id: Option<String>,    // Groups cases from same parameter sweep batch
    pub sweep_case_name: Option<String>,   // Case name within sweep (e.g. "LX_75")
    pub sweep_config: Option<String>,      // JSON: {gpus_per_case, max_concurrent, sweep_name, ...}
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

    // Harden file permissions: 640 (owner rw, group r, others none)
    // Prevents other system users from reading session tokens and password hashes
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(db_path) {
            let mut perms = metadata.permissions();
            perms.set_mode(0o640);
            let _ = std::fs::set_permissions(db_path, perms);
        }
    }

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

    // Migration: add archived flag — allows hiding failed/cancelled jobs without deleting them
    let _ = conn.execute_batch(
        "ALTER TABLE jobs ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;"
    );

    // Migration: add job_type column — distinguishes simulation jobs from render jobs
    let _ = conn.execute_batch(
        "ALTER TABLE jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'simulation';"
    );

    // Migration: add source_job_id — for render jobs, links back to the simulation job
    let _ = conn.execute_batch(
        "ALTER TABLE jobs ADD COLUMN source_job_id INTEGER REFERENCES jobs(id);"
    );

    // ============================================================
    // AI Training tables (Phase 8)
    // ============================================================

    // AI Datasets — sweep → manifest mapping
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_datasets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            sweep_root TEXT NOT NULL,
            sweep_metadata_path TEXT,
            dataset_mode TEXT NOT NULL DEFAULT 'time_averaged_2d',
            manifest_path TEXT,
            cache_path TEXT,
            artifact_root TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            warnings_json TEXT,
            config_json TEXT,
            detected_versions TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_datasets_user ON ai_datasets(user_id);
        CREATE INDEX IF NOT EXISTS idx_ai_datasets_status ON ai_datasets(status);"
    );

    // AI Dataset Cases — per-case metadata within a dataset
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_dataset_cases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dataset_id INTEGER NOT NULL,
            case_name TEXT NOT NULL,
            case_directory TEXT NOT NULL,
            parameters_json TEXT,
            output_files_json TEXT,
            status TEXT NOT NULL DEFAULT 'included',
            exclusion_reason TEXT,
            grid_metadata_json TEXT,
            detected_variables_json TEXT,
            timesteps_json TEXT,
            FOREIGN KEY (dataset_id) REFERENCES ai_datasets(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ai_dataset_cases_dataset ON ai_dataset_cases(dataset_id);"
    );

    // AI Training Jobs — separate from simulation jobs
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_training_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dataset_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            run_name TEXT NOT NULL,
            model_family TEXT NOT NULL,
            config_path TEXT,
            manifest_path TEXT,
            artifact_directory TEXT,
            checkpoint_directory TEXT,
            log_path TEXT,
            metrics_path TEXT,
            status TEXT NOT NULL DEFAULT 'queued',
            pid INTEGER,
            gpu_ids TEXT NOT NULL DEFAULT '[]',
            priority INTEGER NOT NULL DEFAULT 0,
            submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
            started_at TEXT,
            completed_at TEXT,
            exit_code INTEGER,
            failure_reason TEXT,
            resume_from_checkpoint TEXT,
            config_json TEXT,
            FOREIGN KEY (dataset_id) REFERENCES ai_datasets(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_training_status ON ai_training_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_ai_training_user ON ai_training_jobs(user_id);
        CREATE INDEX IF NOT EXISTS idx_ai_training_dataset ON ai_training_jobs(dataset_id);"
    );

    // AI GPU Reservations — coordinated with simulation reservations
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_gpu_reservations (
            gpu_id INTEGER NOT NULL,
            training_job_id INTEGER NOT NULL,
            reserved_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (gpu_id, training_job_id),
            FOREIGN KEY (training_job_id) REFERENCES ai_training_jobs(id) ON DELETE CASCADE
        );"
    );

    // ============================================================
    // Migration: Sweep batch support (Phase 9)
    // ============================================================

    // sweep_group_id: groups related cases from a parameter sweep (UUID)
    let _ = conn.execute_batch(
        "ALTER TABLE jobs ADD COLUMN sweep_group_id TEXT;"
    );
    // sweep_case_name: the case name within the sweep (e.g. "LX_75", "RPM_60")
    let _ = conn.execute_batch(
        "ALTER TABLE jobs ADD COLUMN sweep_case_name TEXT;"
    );
    // sweep_config: JSON blob storing sweep-level settings (gpus_per_case, max_concurrent, etc.)
    let _ = conn.execute_batch(
        "ALTER TABLE jobs ADD COLUMN sweep_config TEXT;"
    );
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_jobs_sweep_group ON jobs(sweep_group_id);"
    );

    // ============================================================
    // Dataset inventory migration (Phase 9 — pure data inventory)
    // ============================================================
    // Add new inventory columns to ai_datasets
    let _ = conn.execute_batch(
        "ALTER TABLE ai_datasets ADD COLUMN stats_inventory_json TEXT;"
    );
    let _ = conn.execute_batch(
        "ALTER TABLE ai_datasets ADD COLUMN pvd_inventory_json TEXT;"
    );
    let _ = conn.execute_batch(
        "ALTER TABLE ai_datasets ADD COLUMN num_cases INTEGER NOT NULL DEFAULT 0;"
    );
    let _ = conn.execute_batch(
        "ALTER TABLE ai_datasets ADD COLUMN num_cases_with_output INTEGER NOT NULL DEFAULT 0;"
    );
    let _ = conn.execute_batch(
        "ALTER TABLE ai_datasets ADD COLUMN sweep_parameters_json TEXT;"
    );
    let _ = conn.execute_batch(
        "ALTER TABLE ai_datasets ADD COLUMN cases_json TEXT;"
    );
    let _ = conn.execute_batch(
        "ALTER TABLE ai_datasets ADD COLUMN source_msb TEXT;"
    );
    let _ = conn.execute_batch(
        "ALTER TABLE ai_datasets ADD COLUMN sweep_group_id TEXT;"
    );
    let _ = conn.execute_batch(
        "ALTER TABLE ai_datasets ADD COLUMN scan_completed_at TEXT;"
    );

    // Housekeeping: purge expired sessions on startup
    match conn.execute("DELETE FROM sessions WHERE expires_at < datetime('now')", []) {
        Ok(n) if n > 0 => println!("[DB] Cleaned up {} expired sessions", n),
        _ => {}
    }

    Ok(Arc::new(Mutex::new(conn)))
}

// ============================================================
// User Operations
// ============================================================

/// Validate that an email address belongs to the allowed domain (if configured).
/// If `allowed_domain` is empty or "*", any valid email is accepted.
pub fn validate_email(email: &str, allowed_domain: &str) -> Result<(), String> {
    let email_lower = email.to_lowercase();
    if !email_lower.contains('@') {
        return Err("Invalid email address".to_string());
    }
    // If no domain restriction is configured, allow any email
    let domain = allowed_domain.trim();
    if domain.is_empty() || domain == "*" {
        return Ok(());
    }
    let required_suffix = format!("@{}", domain.to_lowercase());
    if !email_lower.ends_with(&required_suffix) {
        return Err(format!("Registration is restricted to @{} email addresses", domain));
    }
    Ok(())
}

/// Create a new user, returns the user ID
pub fn create_user(conn: &Connection, username: &str, email: &str, password: &str, role: &str) -> Result<i64, String> {
    // Validate email domain (skip for default admin bootstrap)
    if role != "admin" || email != "admin@localhost" {
        validate_email(email, "")?; // Caller should use validate_email_with_config for domain checks
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
/// List jobs with optional status filter.
/// By default, archived jobs are excluded unless `include_archived` is true
/// or `status_filter` is explicitly "archived".
pub fn list_jobs(conn: &Connection, status_filter: Option<&str>, limit: Option<i64>, include_archived: bool) -> Result<Vec<Job>, String> {
    let limit_val = limit.unwrap_or(100);

    let (query, params_vec): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = if let Some(status) = status_filter {
        if status == "archived" {
            // Special filter: show only archived jobs
            (
                "SELECT j.id, j.user_id, COALESCE(u.username, 'unknown') as username, j.name, j.msb_filename,
                        j.mstar_version, j.gpu_ids, j.unified_memory, j.status, j.priority, j.pid,
                        j.submitted_at, j.started_at, j.completed_at, j.working_directory,
                        j.output_file, j.error_message, j.restart_from_job_id, j.restart_options,
                        j.copy_to_path, j.resolved_version, j.archived,
                        j.job_type, j.source_job_id,
                        j.sweep_group_id, j.sweep_case_name, j.sweep_config
                 FROM jobs j LEFT JOIN users u ON j.user_id = u.id
                 WHERE j.archived = 1
                 ORDER BY j.submitted_at DESC
                 LIMIT ?1".to_string(),
                vec![Box::new(limit_val)]
            )
        } else {
            let archive_clause = if include_archived { "" } else { " AND j.archived = 0" };
            (
                format!("SELECT j.id, j.user_id, COALESCE(u.username, 'unknown') as username, j.name, j.msb_filename,
                        j.mstar_version, j.gpu_ids, j.unified_memory, j.status, j.priority, j.pid,
                        j.submitted_at, j.started_at, j.completed_at, j.working_directory,
                        j.output_file, j.error_message, j.restart_from_job_id, j.restart_options,
                        j.copy_to_path, j.resolved_version, j.archived,
                        j.job_type, j.source_job_id,
                        j.sweep_group_id, j.sweep_case_name, j.sweep_config
                 FROM jobs j LEFT JOIN users u ON j.user_id = u.id
                 WHERE j.status = ?1{}
                 ORDER BY j.priority DESC, j.submitted_at ASC
                 LIMIT ?2", archive_clause),
                vec![Box::new(status.to_string()), Box::new(limit_val)]
            )
        }
    } else {
        let archive_clause = if include_archived { "" } else { " WHERE j.archived = 0" };
        (
            format!("SELECT j.id, j.user_id, COALESCE(u.username, 'unknown') as username, j.name, j.msb_filename,
                    j.mstar_version, j.gpu_ids, j.unified_memory, j.status, j.priority, j.pid,
                    j.submitted_at, j.started_at, j.completed_at, j.working_directory,
                    j.output_file, j.error_message, j.restart_from_job_id, j.restart_options,
                    j.copy_to_path, j.resolved_version, j.archived,
                    j.job_type, j.source_job_id,
                    j.sweep_group_id, j.sweep_case_name, j.sweep_config
             FROM jobs j LEFT JOIN users u ON j.user_id = u.id
             {}
             ORDER BY j.submitted_at DESC
             LIMIT ?1", archive_clause),
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
            archived: row.get::<_, i32>(21)? != 0,
                job_type: row.get::<_, String>(22).unwrap_or_else(|_| "simulation".to_string()),
                source_job_id: row.get(23)?,
                sweep_group_id: row.get(24)?,
                sweep_case_name: row.get(25)?,
                sweep_config: row.get(26)?,
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
                j.copy_to_path, j.resolved_version, j.archived,
                j.job_type, j.source_job_id,
                j.sweep_group_id, j.sweep_case_name, j.sweep_config
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
                archived: row.get::<_, i32>(21)? != 0,
                job_type: row.get::<_, String>(22).unwrap_or_else(|_| "simulation".to_string()),
                source_job_id: row.get(23)?,
                sweep_group_id: row.get(24)?,
                sweep_case_name: row.get(25)?,
                sweep_config: row.get(26)?,
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
         WHERE id = ?1 AND status IN ('queued', 'launching')",
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
         WHERE id = ?1 AND status IN ('running', 'queued', 'launching')",
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
        "SELECT pid FROM jobs WHERE id = ?1 AND status IN ('queued', 'launching', 'running')",
        params![job_id],
        |row| row.get(0),
    ).map_err(|_| format!("Job {} not found or already finished", job_id))?;

    conn.execute(
        "UPDATE jobs SET status = 'cancelled', completed_at = datetime('now'), pid = NULL
         WHERE id = ?1 AND status IN ('queued', 'launching', 'running')",
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
                j.copy_to_path, j.resolved_version, j.archived,
                j.job_type, j.source_job_id,
                j.sweep_group_id, j.sweep_case_name, j.sweep_config
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
                archived: row.get::<_, i32>(21)? != 0,
                job_type: row.get::<_, String>(22).unwrap_or_else(|_| "simulation".to_string()),
                source_job_id: row.get(23)?,
                sweep_group_id: row.get(24)?,
                sweep_case_name: row.get(25)?,
                sweep_config: row.get(26)?,
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
    // IMPORTANT: Query BOTH simulation and AI training GPU reservations
    // to prevent scheduling conflicts between the two subsystems.
    let mut stmt = conn.prepare(
        "SELECT DISTINCT gpu_id FROM gpu_reservations
         UNION
         SELECT DISTINCT gpu_id FROM ai_gpu_reservations"
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
         WHERE status IN ('running', 'launching')",
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
                j.copy_to_path, j.resolved_version, j.archived,
                j.job_type, j.source_job_id,
                j.sweep_group_id, j.sweep_case_name, j.sweep_config
         FROM jobs j LEFT JOIN users u ON j.user_id = u.id
         WHERE j.status IN ('running', 'launching')"
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
            archived: row.get::<_, i32>(21)? != 0,
                job_type: row.get::<_, String>(22).unwrap_or_else(|_| "simulation".to_string()),
                source_job_id: row.get(23)?,
                sweep_group_id: row.get(24)?,
                sweep_case_name: row.get(25)?,
                sweep_config: row.get(26)?,
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

/// Re-queue a stale running job back to "queued" status for automatic restart.
/// Used when auto_requeue_on_restart is enabled and the daemon finds dead processes
/// after a reboot. The job will be re-launched with --load-last (checkpoint restart).
pub fn requeue_stale_job(conn: &Connection, job_id: i64, reason: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE jobs SET status = 'queued', pid = NULL, started_at = NULL, completed_at = NULL,
         error_message = ?2
         WHERE id = ?1 AND status = 'running'",
        params![job_id, reason],
    ).map_err(|e| format!("Failed to requeue stale job {}: {}", job_id, e))?;

    // Release GPU reservations so the scheduler can reassign
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

/// Ensure a default admin user exists (for first-time setup).
/// SECURITY: generates a random password instead of using a hardcoded default.
pub fn ensure_default_admin(conn: &Connection) -> Result<(), String> {
    if !has_admin(conn)? {
        // Generate a cryptographically secure random password
        use rand::Rng;
        let password: String = rand::thread_rng()
            .sample_iter(&rand::distributions::Alphanumeric)
            .take(16)
            .map(char::from)
            .collect();
        create_user(conn, "admin", "admin@localhost", &password, "admin")?;
        println!("==========================================================");
        println!("[SETUP] Created default admin user");
        println!("[SETUP]   Username: admin");
        println!("[SETUP]   Password: {}", password);
        println!("[SETUP]");
        println!("[SETUP]   !! SAVE THIS PASSWORD — IT WILL NOT BE SHOWN AGAIN !!");
        println!("[SETUP]   Change it after first login via the Settings page.");
        println!("==========================================================");
    }
    Ok(())
}

/// Create a restart job from a failed job.
/// The new job reuses the same working directory and config but uses --load-last on launch.
/// Optional override parameters allow the user to change version, GPUs, priority, etc.
pub fn create_restart_job(
    conn: &Connection,
    original_job_id: i64,
    restart_options: Option<&str>,
    gpu_ids_override: Option<&str>,
    version_override: Option<&str>,
    priority_override: Option<i32>,
    unified_memory_override: Option<bool>,
    copy_to_override: Option<&str>,
) -> Result<i64, String> {
    // Fetch the original job
    let orig = get_job(conn, original_job_id)?;

    if orig.status != "failed" && orig.status != "cancelled" {
        return Err(format!("Can only restart failed/cancelled jobs (current status: {})", orig.status));
    }

    let restart_opts_val = restart_options.unwrap_or("{}");

    // Use overrides when provided, otherwise fall back to original job values
    let gpu_ids = gpu_ids_override.unwrap_or(&orig.gpu_ids);
    let mstar_version = version_override
        .unwrap_or_else(|| orig.resolved_version.as_deref().unwrap_or(&orig.mstar_version));
    let priority = priority_override.unwrap_or(orig.priority);
    let unified_memory = unified_memory_override.unwrap_or(orig.unified_memory);
    let copy_to = copy_to_override.or(orig.copy_to_path.as_deref());

    conn.execute(
        "INSERT INTO jobs (user_id, name, msb_filename, mstar_version, gpu_ids, unified_memory,
                           status, priority, restart_from_job_id, restart_options, copy_to_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, ?8, ?9, ?10)",
        params![
            orig.user_id,
            format!("{} (restart)", orig.name),
            orig.msb_filename,
            mstar_version,
            gpu_ids,
            unified_memory as i32,
            priority,
            original_job_id,
            restart_opts_val,
            copy_to,
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

/// Archive a single failed or cancelled job (hides it from the default job list).
pub fn archive_job(conn: &Connection, job_id: i64) -> Result<(), String> {
    let changes = conn.execute(
        "UPDATE jobs SET archived = 1 WHERE id = ?1 AND status IN ('failed', 'cancelled', 'completed')",
        params![job_id],
    ).map_err(|e| format!("Failed to archive job: {}", e))?;

    if changes == 0 {
        Err(format!("Job {} not found or not in a terminal state", job_id))
    } else {
        Ok(())
    }
}

/// Archive all failed jobs at once.
pub fn archive_all_failed(conn: &Connection) -> Result<usize, String> {
    let changes = conn.execute(
        "UPDATE jobs SET archived = 1 WHERE status = 'failed' AND archived = 0",
        [],
    ).map_err(|e| format!("Failed to archive failed jobs: {}", e))?;

    Ok(changes)
}

/// Create a render job — uses an existing simulation job's output or a direct
/// filesystem path as input for ParaView-based video rendering.
///
/// `source_job_id` is `Some(id)` when rendering from a queue job, or `None`
/// when rendering from a direct path (e.g. Browse Server).  The `source_label`
/// is a display string stored in msb_filename (e.g. the MSB name or directory).
pub fn create_render_job(
    conn: &Connection,
    user_id: i64,
    name: &str,
    source_job_id: Option<i64>,
    source_label: &str,
    mstar_version: &str,
    gpu_ids: &str,
    render_options_json: &str,
) -> Result<i64, String> {
    // If a source job ID was provided, verify it exists and has a working directory
    if let Some(job_id) = source_job_id {
        let source = get_job(conn, job_id)?;
        if source.working_directory.is_none() {
            return Err(format!("Source job {} has no working directory", job_id));
        }
    }

    conn.execute(
        "INSERT INTO jobs (user_id, name, msb_filename, mstar_version, gpu_ids, unified_memory,
         priority, job_type, source_job_id, restart_options)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, 'render', ?6, ?7)",
        params![
            user_id,
            name,
            source_label,
            mstar_version,
            gpu_ids,
            source_job_id,
            render_options_json,
        ],
    ).map_err(|e| format!("Failed to create render job: {}", e))?;

    Ok(conn.last_insert_rowid())
}

/// Create a simulation job that is part of a parameter sweep batch.
///
/// Each case gets its own job but they share a `sweep_group_id` for grouped
/// monitoring and concurrency control.  The `sweep_config` JSON contains
/// the per-sweep settings (gpus_per_case, max_concurrent, sweep_name, etc.).
pub fn create_sweep_job(
    conn: &Connection,
    user_id: i64,
    name: &str,
    msb_filename: &str,
    mstar_version: &str,
    gpu_ids: &str,
    unified_memory: bool,
    priority: i32,
    copy_to_path: Option<&str>,
    sweep_group_id: &str,
    sweep_case_name: &str,
    sweep_config: &str,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO jobs (user_id, name, msb_filename, mstar_version, gpu_ids, unified_memory,
         priority, copy_to_path, sweep_group_id, sweep_case_name, sweep_config)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            user_id, name, msb_filename, mstar_version, gpu_ids,
            unified_memory as i32, priority, copy_to_path,
            sweep_group_id, sweep_case_name, sweep_config,
        ],
    ).map_err(|e| format!("Failed to create sweep job: {}", e))?;

    Ok(conn.last_insert_rowid())
}

/// Count how many jobs in a sweep group are currently active (queued, launching, or running).
pub fn count_active_sweep_jobs(conn: &Connection, sweep_group_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM jobs WHERE sweep_group_id = ?1 AND status IN ('running', 'launching')",
        params![sweep_group_id],
        |row| row.get(0),
    ).map_err(|e| format!("Failed to count active sweep jobs: {}", e))
}

/// List all jobs in a sweep group.
pub fn list_sweep_jobs(conn: &Connection, sweep_group_id: &str) -> Result<Vec<Job>, String> {
    let query = "SELECT j.id, j.user_id, COALESCE(u.username, 'unknown') as username, j.name, j.msb_filename,
                j.mstar_version, j.gpu_ids, j.unified_memory, j.status, j.priority, j.pid,
                j.submitted_at, j.started_at, j.completed_at, j.working_directory,
                j.output_file, j.error_message, j.restart_from_job_id, j.restart_options,
                j.copy_to_path, j.resolved_version, j.archived,
                j.job_type, j.source_job_id,
                j.sweep_group_id, j.sweep_case_name, j.sweep_config
         FROM jobs j LEFT JOIN users u ON j.user_id = u.id
         WHERE j.sweep_group_id = ?1
         ORDER BY j.submitted_at ASC";

    let mut stmt = conn.prepare(query)
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let jobs = stmt.query_map(params![sweep_group_id], |row| {
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
            archived: row.get::<_, i32>(21)? != 0,
            job_type: row.get::<_, String>(22).unwrap_or_else(|_| "simulation".to_string()),
            source_job_id: row.get(23)?,
            sweep_group_id: row.get(24)?,
            sweep_case_name: row.get(25)?,
            sweep_config: row.get(26)?,
        })
    }).map_err(|e| format!("Failed to query jobs: {}", e))?
    .filter_map(|r| r.ok())
    .collect();

    Ok(jobs)
}

/// Cancel all pending jobs in a sweep group (those still queued).
pub fn cancel_sweep_group(conn: &Connection, sweep_group_id: &str) -> Result<usize, String> {
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    conn.execute(
        "UPDATE jobs SET status = 'cancelled', completed_at = ?1
         WHERE sweep_group_id = ?2 AND status IN ('queued')",
        params![now, sweep_group_id],
    ).map_err(|e| format!("Failed to cancel sweep group: {}", e))
}

