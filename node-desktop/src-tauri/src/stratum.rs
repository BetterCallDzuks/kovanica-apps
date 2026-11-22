//! Stratum V1 Gateway supervisor, config validation, and observability monitor.
//!
//! Supervises a single owned `kovanica-stratum` child process with argv-only
//! execution (never via a shell), bounded SIGTERM -> SIGKILL teardown, and
//! read-only loopback polling of its `/health` observability endpoint.

use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::monitor::{Field, RpcReach, HEALTH_TIMEOUT};
use crate::policy::is_loopback_host;
use crate::redact::redact_log_line;
use crate::supervisor::{ProcessState, ProcessStatus, KILL_WAIT, LOG_LINES};

pub const DEFAULT_STRATUM_HOST: &str = "127.0.0.1";
pub const DEFAULT_STRATUM_PORT: u16 = 3333;
pub const DEFAULT_UPSTREAM_RPC_URL: &str = "http://127.0.0.1:8545";
pub const DEFAULT_METRICS_ADDR: &str = "127.0.0.1:9090";
pub const DEFAULT_CHAIN_ID: u64 = 2;
pub const DEFAULT_DIFFICULTY: f64 = 1.0;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StratumConfigInput {
    pub binary: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub rpc_url: String,
    pub metrics_addr: String,
    pub chain_id: u64,
    pub difficulty: f64,
    pub tls_enabled: bool,
    pub tls_cert_path: Option<String>,
    pub tls_key_path: Option<String>,
    pub tls_self_signed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckedStratumConfig {
    pub binary: String,
    pub binary_sha256: String,
    pub listen_addr: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub rpc_url: String,
    pub metrics_addr: String,
    pub health_url: String,
    pub chain_id: u64,
    pub difficulty: f64,
    pub tls_enabled: bool,
    pub tls_cert_path: Option<String>,
    pub tls_key_path: Option<String>,
    pub tls_self_signed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StratumHealthView {
    pub reach: RpcReach,
    pub status: Field,
    pub uptime_seconds: Field,
    pub active_connections: Field,
    pub current_job_id: Field,
    pub tls_enabled: Field,
    pub timestamp: Field,
    pub detail: Option<String>,
}

impl StratumHealthView {
    pub fn unknown() -> Self {
        Self::blank(RpcReach::Unknown, false, None)
    }

    pub fn unavailable(detail: Option<String>) -> Self {
        Self::blank(RpcReach::Unreachable, true, detail)
    }

    fn blank(reach: RpcReach, failed: bool, detail: Option<String>) -> Self {
        let field = if failed {
            Field::unavailable()
        } else {
            Field::unknown()
        };
        Self {
            reach,
            status: field.clone(),
            uptime_seconds: field.clone(),
            active_connections: field.clone(),
            current_job_id: field.clone(),
            tls_enabled: field.clone(),
            timestamp: field,
            detail,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StratumSnapshot {
    pub process: ProcessStatus,
    pub health: StratumHealthView,
    pub health_seq: u64,
    pub config: Option<CheckedStratumConfig>,
    pub stop_grace_secs: u64,
}

/// Validate Stratum Gateway configuration before spawning.
pub fn check_stratum_config(input: &StratumConfigInput) -> Result<CheckedStratumConfig, String> {
    let binary_path = require_absolute_file(Path::new(input.binary.trim()), "stratum executable")?;
    if !is_executable(&binary_path) {
        return Err(format!(
            "{} is not executable. Pass the absolute path of a kovanica-stratum binary.",
            binary_path.display()
        ));
    }

    let bind_host = input.bind_host.trim();
    if bind_host.is_empty() {
        return Err("bind host is required (for example 127.0.0.1 or 0.0.0.0).".into());
    }
    let parsed_ip: IpAddr = bind_host.parse().map_err(|_| {
        format!("bind host {bind_host:?} is not a valid IPv4 or IPv6 address.")
    })?;
    if input.bind_port == 0 {
        return Err("bind port must be between 1 and 65535.".into());
    }
    let listen_addr = SocketAddr::new(parsed_ip, input.bind_port).to_string();

    let rpc_url = input.rpc_url.trim();
    if !rpc_url.starts_with("http://") && !rpc_url.starts_with("https://") {
        return Err(
            "upstream RPC URL must start with http:// or https:// (for example http://127.0.0.1:8545)."
                .into(),
        );
    }
    if rpc_url.len() <= "http://".len() || rpc_url.contains(char::is_whitespace) {
        return Err("upstream RPC URL must not be empty or contain whitespace.".into());
    }

    let metrics_raw = input.metrics_addr.trim();
    let metrics_sock: SocketAddr = metrics_raw.parse().map_err(|_| {
        format!("metrics address {metrics_raw:?} must be host:port (for example 127.0.0.1:9090).")
    })?;
    if !is_loopback_host(&metrics_sock.ip().to_string()) {
        return Err(format!(
            "metrics address {metrics_raw:?} must bind to a loopback IP (127.0.0.1 or ::1)."
        ));
    }

    if !matches!(input.chain_id, 1 | 2 | 3) {
        return Err(format!(
            "chain id {} is not supported (expected 1, 2, or 3).",
            input.chain_id
        ));
    }

    if !input.difficulty.is_finite() || input.difficulty <= 0.0 {
        return Err("initial share difficulty must be a positive finite number.".into());
    }

    let mut tls_cert_path: Option<String> = None;
    let mut tls_key_path: Option<String> = None;
    if input.tls_enabled {
        if !input.tls_self_signed {
            let cert_raw = input.tls_cert_path.as_deref().unwrap_or("").trim();
            let key_raw = input.tls_key_path.as_deref().unwrap_or("").trim();
            if cert_raw.is_empty() || key_raw.is_empty() {
                return Err(
                    "TLS is enabled: provide both absolute TLS certificate and private key paths, or enable self-signed TLS for testing."
                        .into(),
                );
            }
            let cert = require_absolute_file(Path::new(cert_raw), "TLS certificate file")?;
            let key = require_absolute_file(Path::new(key_raw), "TLS private key file")?;
            tls_cert_path = Some(cert.display().to_string());
            tls_key_path = Some(key.display().to_string());
        } else {
            // Optional output paths when self-signed is enabled
            if let Some(cert_raw) = input.tls_cert_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let path = Path::new(cert_raw);
                if !path.is_absolute() {
                    return Err("TLS certificate path must be absolute.".into());
                }
                tls_cert_path = Some(cert_raw.to_string());
            }
            if let Some(key_raw) = input.tls_key_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let path = Path::new(key_raw);
                if !path.is_absolute() {
                    return Err("TLS key path must be absolute.".into());
                }
                tls_key_path = Some(key_raw.to_string());
            }
        }
    }

    let binary_sha256 = sha256_file(&binary_path)?;
    let health_url = format!("http://{metrics_sock}/health");

    Ok(CheckedStratumConfig {
        binary: binary_path.display().to_string(),
        binary_sha256,
        listen_addr,
        bind_host: bind_host.to_string(),
        bind_port: input.bind_port,
        rpc_url: rpc_url.to_string(),
        metrics_addr: metrics_sock.to_string(),
        health_url,
        chain_id: input.chain_id,
        difficulty: input.difficulty,
        tls_enabled: input.tls_enabled,
        tls_cert_path,
        tls_key_path,
        tls_self_signed: input.tls_enabled && input.tls_self_signed,
    })
}

/// Build the exact CLI argv passed to `kovanica-stratum`.
pub fn build_stratum_args(cfg: &CheckedStratumConfig) -> Vec<String> {
    let mut args = vec![
        "--listen".to_string(),
        cfg.listen_addr.clone(),
        "--rpc-url".to_string(),
        cfg.rpc_url.clone(),
        "--chain-id".to_string(),
        cfg.chain_id.to_string(),
        "--difficulty".to_string(),
        cfg.difficulty.to_string(),
        "--metrics-addr".to_string(),
        cfg.metrics_addr.clone(),
        "--log-format".to_string(),
        "pretty".to_string(),
    ];
    if cfg.tls_enabled {
        args.push("--tls".to_string());
        if cfg.tls_self_signed {
            args.push("--tls-self-signed".to_string());
        }
        if let Some(cert) = &cfg.tls_cert_path {
            args.push("--tls-cert".to_string());
            args.push(cert.clone());
        }
        if let Some(key) = &cfg.tls_key_path {
            args.push("--tls-key".to_string());
            args.push(key.clone());
        }
    }
    args
}

/// Parse the JSON returned by `kovanica-stratum`'s `GET /health` endpoint.
pub fn parse_stratum_health(http_status: u16, body: &str) -> StratumHealthView {
    if http_status != 200 {
        return StratumHealthView::unavailable(Some(format!("health HTTP {http_status}")));
    }
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return StratumHealthView::unavailable(Some("health response was not valid JSON".into()));
    };
    let Some(obj) = value.as_object() else {
        return StratumHealthView::unavailable(Some("health response was not a JSON object".into()));
    };

    let status = match obj.get("status").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Field::value(s),
        _ => Field::unknown(),
    };
    let uptime_seconds = match obj.get("uptime_seconds").and_then(Value::as_u64) {
        Some(v) => Field::value(v.to_string()),
        None => Field::unknown(),
    };
    let active_connections = match obj.get("active_connections").and_then(Value::as_i64) {
        Some(v) if v >= 0 => Field::value(v.to_string()),
        _ => Field::unknown(),
    };
    let current_job_id = match obj.get("current_job_id") {
        Some(Value::String(s)) if !s.is_empty() => Field::value(s),
        Some(Value::Null) => Field::value("(none)"),
        _ => Field::unknown(),
    };
    let tls_enabled = match obj.get("tls_enabled").and_then(Value::as_bool) {
        Some(b) => Field::value(if b { "true" } else { "false" }),
        None => Field::unknown(),
    };
    let timestamp = match obj.get("timestamp").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Field::value(s),
        _ => Field::unknown(),
    };

    StratumHealthView {
        reach: RpcReach::Reachable,
        status,
        uptime_seconds,
        active_connections,
        current_job_id,
        tls_enabled,
        timestamp,
        detail: None,
    }
}

pub async fn fetch_stratum_health(health_url: &str) -> Result<StratumHealthView, String> {
    let client = reqwest::Client::builder()
        .timeout(HEALTH_TIMEOUT)
        .connect_timeout(HEALTH_TIMEOUT)
        .build()
        .map_err(|err| err.to_string())?;
    let resp = client
        .get(health_url)
        .send()
        .await
        .map_err(|err| format!("stratum health request failed: {err}"))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|err| format!("stratum health body failed: {err}"))?;
    Ok(parse_stratum_health(status, &body))
}

struct StratumInner {
    child: Option<Child>,
    state: ProcessState,
    pid: Option<u32>,
    owns_group: bool,
    exit_code: Option<i32>,
    last_error: Option<String>,
    status_seq: u64,
    health: StratumHealthView,
    health_seq: u64,
    config: Option<CheckedStratumConfig>,
}

impl StratumInner {
    fn observe(&mut self) {
        self.status_seq = self.status_seq.wrapping_add(1);
    }
}

pub struct StratumSession {
    inner: Mutex<StratumInner>,
    logs: Arc<Mutex<VecDeque<String>>>,
    grace: Duration,
    kill_wait: Duration,
}

impl StratumSession {
    pub fn new(grace: Duration) -> Self {
        Self {
            inner: Mutex::new(StratumInner {
                child: None,
                state: ProcessState::Stopped,
                pid: None,
                owns_group: false,
                exit_code: None,
                last_error: None,
                status_seq: 1,
                health: StratumHealthView::unknown(),
                health_seq: 1,
                config: None,
            }),
            logs: Arc::new(Mutex::new(VecDeque::new())),
            grace,
            kill_wait: KILL_WAIT,
        }
    }

    pub fn store_config(&self, cfg: CheckedStratumConfig) {
        self.inner.lock().expect("stratum lock").config = Some(cfg);
    }

    pub fn snapshot(&self) -> StratumSnapshot {
        self.reap();
        let inner = self.inner.lock().expect("stratum lock");
        let process = ProcessStatus {
            state: inner.state,
            pid: inner.pid,
            exit_code: inner.exit_code,
            last_error: inner.last_error.clone(),
            logs: self
                .logs
                .lock()
                .expect("stratum log lock")
                .iter()
                .cloned()
                .collect(),
            status_seq: inner.status_seq,
        };
        let health = if inner.state == ProcessState::Exited {
            StratumHealthView::unavailable(Some(match inner.exit_code {
                Some(code) => format!("stratum gateway exited with code {code}; health is not live"),
                None => "stratum gateway exited; health is not live".into(),
            }))
        } else {
            inner.health.clone()
        };
        StratumSnapshot {
            process,
            health,
            health_seq: inner.health_seq,
            config: inner.config.clone(),
            stop_grace_secs: self.grace.as_secs(),
        }
    }

    pub fn start(&self, cfg: CheckedStratumConfig) -> Result<StratumSnapshot, String> {
        self.reap();
        {
            let inner = self.inner.lock().expect("stratum lock");
            if matches!(
                inner.state,
                ProcessState::Starting | ProcessState::Running | ProcessState::Stopping
            ) {
                return Err(
                    "Stratum gateway is already running. Stop or restart it instead.".into(),
                );
            }
        }

        let argv = build_stratum_args(&cfg);
        let mut command = Command::new(&cfg.binary);
        command
            .args(&argv)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(unix)]
        unsafe {
            use std::os::unix::process::CommandExt;
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut spawn_result = command.spawn();
        for attempt in 0..10 {
            match &spawn_result {
                Ok(_) => break,
                Err(err) if err.raw_os_error() == Some(26) && attempt < 9 => {
                    thread::sleep(Duration::from_millis(5));
                    spawn_result = command.spawn();
                }
                Err(_) => break,
            }
        }

        let mut child = spawn_result.map_err(|err| {
            let mut inner = self.inner.lock().expect("stratum lock");
            inner.state = ProcessState::Stopped;
            inner.last_error = Some(format!("could not start {}: {err}", cfg.binary));
            inner.observe();
            inner.last_error.clone().unwrap()
        })?;

        let pid = child.id();
        if pid == 0 {
            let _ = child.kill();
            let _ = child.wait();
            return Err("refusing a stratum child pid of 0".into());
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        {
            let mut inner = self.inner.lock().expect("stratum lock");
            inner.child = Some(child);
            inner.state = ProcessState::Running;
            inner.pid = Some(pid);
            inner.owns_group = true;
            inner.exit_code = None;
            inner.last_error = None;
            inner.config = Some(cfg.clone());
            inner.health = StratumHealthView::unknown();
            inner.health_seq = inner.health_seq.wrapping_add(1);
            inner.observe();
        }
        {
            let mut logs = self.logs.lock().expect("stratum log lock");
            logs.clear();
            push_log(
                &mut logs,
                format!(
                    "started stratum pid {pid} listen={} rpc={} tls={}",
                    cfg.listen_addr, cfg.rpc_url, cfg.tls_enabled
                ),
            );
        }
        if let Some(stdout) = stdout {
            spawn_reader(Arc::clone(&self.logs), stdout);
        }
        if let Some(stderr) = stderr {
            spawn_reader(Arc::clone(&self.logs), stderr);
        }

        Ok(self.snapshot())
    }

    pub fn stop(&self) -> Result<StratumSnapshot, String> {
        let pid = {
            let mut inner = self.inner.lock().expect("stratum lock");
            match inner.state {
                ProcessState::Starting | ProcessState::Running | ProcessState::Stopping => {}
                ProcessState::Stopped | ProcessState::Exited => {
                    drop(inner);
                    return Ok(self.snapshot());
                }
            }
            let Some(pid) = inner.pid else {
                inner.last_error = Some("stopping stratum without a pid.".into());
                inner.observe();
                return Err(inner.last_error.clone().unwrap());
            };
            if !inner.owns_group || pid == 0 || inner.child.is_none() {
                inner.state = ProcessState::Stopping;
                inner.last_error = Some("refusing to signal an unowned stratum process.".into());
                inner.observe();
                return Err(inner.last_error.clone().unwrap());
            }
            inner.state = ProcessState::Stopping;
            inner.observe();
            pid
        };

        if self.confirmed_exit() {
            return Ok(self.snapshot());
        }

        let _ = signal_group(pid, libc::SIGTERM);
        let deadline = Instant::now() + self.grace;
        while Instant::now() < deadline {
            if self.confirmed_exit() {
                return Ok(self.snapshot());
            }
            thread::sleep(Duration::from_millis(25));
        }

        let _ = signal_group(pid, libc::SIGKILL);
        let kill_deadline = Instant::now() + self.kill_wait;
        while Instant::now() < kill_deadline {
            if self.confirmed_exit() {
                return Ok(self.snapshot());
            }
            thread::sleep(Duration::from_millis(25));
        }

        let mut inner = self.inner.lock().expect("stratum lock");
        inner.state = ProcessState::Stopping;
        inner.last_error = Some(format!(
            "stratum pid {pid} was not confirmed exited after SIGTERM and SIGKILL."
        ));
        inner.observe();
        Err(inner.last_error.clone().unwrap())
    }

    pub fn restart(&self, cfg: CheckedStratumConfig) -> Result<StratumSnapshot, String> {
        self.stop()?;
        self.start(cfg)
    }

    pub fn health_target(&self) -> Option<String> {
        self.reap();
        let inner = self.inner.lock().expect("stratum lock");
        if inner.state != ProcessState::Running {
            return None;
        }
        inner.config.as_ref().map(|c| c.health_url.clone())
    }

    pub fn record_health(&self, view: StratumHealthView) {
        let mut inner = self.inner.lock().expect("stratum lock");
        if inner.state != ProcessState::Running {
            return;
        }
        inner.health = view;
        inner.health_seq = inner.health_seq.wrapping_add(1);
    }

    fn confirmed_exit(&self) -> bool {
        self.reap();
        matches!(
            self.inner.lock().expect("stratum lock").state,
            ProcessState::Exited | ProcessState::Stopped
        )
    }

    fn reap(&self) {
        let mut inner = self.inner.lock().expect("stratum lock");
        let Some(child) = inner.child.as_mut() else {
            return;
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code();
                inner.exit_code = code;
                inner.pid = None;
                inner.owns_group = false;
                inner.last_error = None;
                inner.child = None;
                inner.state = ProcessState::Exited;
                inner.health_seq = inner.health_seq.wrapping_add(1);
                inner.observe();
                drop(inner);
                let mut logs = self.logs.lock().expect("stratum log lock");
                push_log(
                    &mut logs,
                    format!(
                        "stratum exited code {}",
                        code.map(|v| v.to_string())
                            .unwrap_or_else(|| "signal".into())
                    ),
                );
            }
            Ok(None) => {}
            Err(err) => {
                inner.last_error = Some(format!("could not wait for stratum child: {err}"));
                inner.observe();
            }
        }
    }
}

fn signal_group(pid: u32, signal: i32) -> std::io::Result<()> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid pid",
        ));
    }
    let pgid = -(pid as i32);
    let rc = unsafe { libc::kill(pgid, signal) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn push_log(logs: &mut VecDeque<String>, line: String) {
    if let Some(safe) = redact_log_line(&line) {
        logs.push_back(safe);
        while logs.len() > LOG_LINES {
            logs.pop_front();
        }
    }
}

fn spawn_reader<R: Read + Send + 'static>(logs: Arc<Mutex<VecDeque<String>>>, pipe: R) {
    thread::spawn(move || {
        let reader = BufReader::new(pipe);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if let Ok(mut logs) = logs.lock() {
                push_log(&mut logs, line);
            }
        }
    });
}

fn require_absolute_file(path: &Path, what: &str) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err(format!("choose a {what} before continuing."));
    }
    if !path.is_absolute() {
        return Err(format!(
            "{what} must be an absolute path ({}).",
            path.display()
        ));
    }
    let meta =
        fs::metadata(path).map_err(|_| format!("{what} does not exist: {}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{what} is not a file: {}", path.display()));
    }
    Ok(path.to_path_buf())
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|meta| meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|err| format!("could not hash {}: {err}", path.display()))?;
    let digest = Sha256::digest(bytes);
    Ok(format!("{digest:x}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    fn make_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        {
            let mut f = fs::File::create(&path).unwrap();
            f.write_all(body.as_bytes()).unwrap();
            f.sync_all().unwrap();
        }
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
        thread::sleep(Duration::from_millis(1));
        path
    }

    fn base_input(binary: &Path) -> StratumConfigInput {
        StratumConfigInput {
            binary: binary.display().to_string(),
            bind_host: "127.0.0.1".into(),
            bind_port: 3333,
            rpc_url: "http://127.0.0.1:8545".into(),
            metrics_addr: "127.0.0.1:9090".into(),
            chain_id: 2,
            difficulty: 1.0,
            tls_enabled: false,
            tls_cert_path: None,
            tls_key_path: None,
            tls_self_signed: false,
        }
    }

    #[test]
    fn validates_stratum_config_and_tls_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = make_script(tmp.path(), "kovanica-stratum", "#!/bin/sh\nexit 0\n");

        let checked = check_stratum_config(&base_input(&bin)).unwrap();
        assert_eq!(checked.listen_addr, "127.0.0.1:3333");
        assert_eq!(checked.health_url, "http://127.0.0.1:9090/health");
        assert_eq!(checked.binary_sha256.len(), 64);

        // Non-loopback metrics address rejected
        let mut bad_metrics = base_input(&bin);
        bad_metrics.metrics_addr = "0.0.0.0:9090".into();
        assert!(check_stratum_config(&bad_metrics)
            .unwrap_err()
            .contains("loopback"));

        // Invalid bind host rejected
        let mut bad_host = base_input(&bin);
        bad_host.bind_host = "not-an-ip".into();
        assert!(check_stratum_config(&bad_host)
            .unwrap_err()
            .contains("valid IPv4 or IPv6"));

        // TLS enabled without cert/key or self-signed rejected
        let mut bad_tls = base_input(&bin);
        bad_tls.tls_enabled = true;
        assert!(check_stratum_config(&bad_tls)
            .unwrap_err()
            .contains("TLS is enabled"));

        // TLS enabled with cert and key accepted
        let cert = tmp.path().join("cert.pem");
        let key = tmp.path().join("key.pem");
        fs::write(&cert, b"CERT").unwrap();
        fs::write(&key, b"KEY").unwrap();
        let mut ok_tls = base_input(&bin);
        ok_tls.tls_enabled = true;
        ok_tls.tls_cert_path = Some(cert.display().to_string());
        ok_tls.tls_key_path = Some(key.display().to_string());
        let checked_tls = check_stratum_config(&ok_tls).unwrap();
        assert!(checked_tls.tls_enabled);
        assert!(!checked_tls.tls_self_signed);
        let args = build_stratum_args(&checked_tls);
        assert!(args.contains(&"--tls".to_string()));
        assert!(args.contains(&"--tls-cert".to_string()));
        assert!(args.contains(&"--tls-key".to_string()));

        // TLS self-signed accepted without existing files
        let mut self_signed = base_input(&bin);
        self_signed.tls_enabled = true;
        self_signed.tls_self_signed = true;
        let checked_ss = check_stratum_config(&self_signed).unwrap();
        assert!(checked_ss.tls_self_signed);
        let ss_args = build_stratum_args(&checked_ss);
        assert!(ss_args.contains(&"--tls-self-signed".to_string()));
    }

    #[test]
    fn parses_stratum_health_json() {
        let body = r#"{
            "status": "healthy",
            "uptime_seconds": 42,
            "active_connections": 7,
            "current_job_id": "job-0001",
            "tls_enabled": true,
            "timestamp": "2026-11-22T22:00:00Z"
        }"#;
        let view = parse_stratum_health(200, body);
        assert_eq!(view.reach, RpcReach::Reachable);
        assert_eq!(view.status, Field::value("healthy"));
        assert_eq!(view.uptime_seconds, Field::value("42"));
        assert_eq!(view.active_connections, Field::value("7"));
        assert_eq!(view.current_job_id, Field::value("job-0001"));
        assert_eq!(view.tls_enabled, Field::value("true"));

        let no_job = parse_stratum_health(
            200,
            r#"{"status":"healthy","uptime_seconds":0,"active_connections":0,"current_job_id":null,"tls_enabled":false}"#,
        );
        assert_eq!(no_job.current_job_id, Field::value("(none)"));
        assert_eq!(no_job.uptime_seconds, Field::value("0"));

        let overloaded = parse_stratum_health(503, "too many concurrent observability requests");
        assert_eq!(overloaded.reach, RpcReach::Unreachable);
        assert!(overloaded.detail.unwrap().contains("503"));
    }

    #[test]
    fn supervises_start_restart_and_stop_lifecycle() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = make_script(
            tmp.path(),
            "fake-stratum.sh",
            "#!/bin/sh\ntrap 'exit 0' TERM\necho 'stratum listening'\nwhile true; do sleep 0.05; done\n",
        );
        let cfg = check_stratum_config(&base_input(&bin)).unwrap();
        let session = StratumSession::new(Duration::from_millis(300));

        let started = session.start(cfg.clone()).unwrap();
        assert_eq!(started.process.state, ProcessState::Running);
        let first_pid = started.process.pid.expect("pid");
        assert!(session.health_target().is_some());

        // Duplicate start refused
        assert!(session.start(cfg.clone()).is_err());

        // Restart produces a new pid
        let restarted = session.restart(cfg).unwrap();
        assert_eq!(restarted.process.state, ProcessState::Running);
        let second_pid = restarted.process.pid.expect("second pid");
        assert_ne!(first_pid, second_pid);

        // Stop reaps child and marks health unavailable
        let stopped = session.stop().unwrap();
        assert_eq!(stopped.process.state, ProcessState::Exited);
        assert_eq!(stopped.process.pid, None);
        assert_eq!(stopped.health.reach, RpcReach::Unreachable);
        assert!(session.health_target().is_none());
    }
}
