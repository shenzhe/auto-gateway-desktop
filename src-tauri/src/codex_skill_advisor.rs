use serde_json::{json, Value};
use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const APP_SERVER_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_DIAGNOSTIC_BYTES: usize = 16 * 1024;

pub struct CodexAdvisorOutput {
    pub content: String,
    pub thread_id: String,
}

#[derive(Clone, Debug)]
struct CodexCommand {
    program: PathBuf,
    prefix_args: Vec<OsString>,
}

struct CodexAppServer {
    child: Child,
    stdin: ChildStdin,
    messages: mpsc::Receiver<Result<Value, String>>,
    pending: VecDeque<Value>,
    stderr: Arc<Mutex<String>>,
}

impl CodexAppServer {
    fn spawn(workspace: &Path, deadline: Instant) -> Result<Self, String> {
        fs::create_dir_all(workspace)
            .map_err(|error| format!("create the Codex advisor workspace: {error}"))?;
        let mut last_error = "the Codex CLI is not installed".to_string();
        for executable in codex_command_candidates() {
            if Instant::now() >= deadline {
                break;
            }
            let mut server = match Self::spawn_with_command(workspace, &executable) {
                Ok(server) => server,
                Err(error) => {
                    last_error = error;
                    continue;
                }
            };
            let initialize_deadline =
                std::cmp::min(deadline, Instant::now() + Duration::from_secs(8));
            match server.initialize(initialize_deadline) {
                Ok(()) => return Ok(server),
                Err(error) => last_error = error,
            }
        }
        Err(last_error)
    }

    fn spawn_with_command(workspace: &Path, executable: &CodexCommand) -> Result<Self, String> {
        let mut command = Command::new(&executable.program);
        command
            .args(&executable.prefix_args)
            .arg("app-server")
            .current_dir(workspace)
            .env("PATH", codex_process_path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("start {}: {error}", executable.program.to_string_lossy()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "open Codex app-server input".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "open Codex app-server output".to_string())?;
        let stderr_pipe = child
            .stderr
            .take()
            .ok_or_else(|| "open Codex app-server diagnostics".to_string())?;
        let (sender, messages) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let message = line
                    .map_err(|error| format!("read Codex app-server output: {error}"))
                    .and_then(|line| {
                        serde_json::from_str::<Value>(&line)
                            .map_err(|error| format!("decode Codex app-server output: {error}"))
                    });
                let failed = message.is_err();
                if sender.send(message).is_err() || failed {
                    break;
                }
            }
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        let stderr_output = Arc::clone(&stderr);
        thread::spawn(move || drain_diagnostics(stderr_pipe, stderr_output));
        Ok(Self {
            child,
            stdin,
            messages,
            pending: VecDeque::new(),
            stderr,
        })
    }

    fn initialize(&mut self, deadline: Instant) -> Result<(), String> {
        self.request(
            1,
            "initialize",
            json!({
                "clientInfo": {
                    "name": "auto_gateway_desktop",
                    "title": "AUTO Gateway Desktop",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
            deadline,
        )?;
        self.notify("initialized", json!({}))
    }

    fn request(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        deadline: Instant,
    ) -> Result<Value, String> {
        self.send(&json!({ "method": method, "id": id, "params": params }))?;
        let mut deferred = VecDeque::new();
        loop {
            let message = self.receive(deadline)?;
            if message.get("id").and_then(Value::as_u64) == Some(id)
                && message.get("method").is_none()
            {
                self.pending.extend(deferred);
                if let Some(error) = message.get("error") {
                    return Err(json_rpc_error(error));
                }
                return message
                    .get("result")
                    .cloned()
                    .ok_or_else(|| format!("Codex returned no result for {method}"));
            }
            if is_server_request(&message) {
                self.decline_server_request(&message)?;
            } else {
                deferred.push_back(message);
            }
        }
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({ "method": method, "params": params }))
    }

    fn send(&mut self, message: &Value) -> Result<(), String> {
        serde_json::to_writer(&mut self.stdin, message)
            .map_err(|error| format!("encode a Codex app-server request: {error}"))?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("send a Codex app-server request: {error}"))
    }

    fn next_message(&mut self, deadline: Instant) -> Result<Value, String> {
        if let Some(message) = self.pending.pop_front() {
            return Ok(message);
        }
        self.receive(deadline)
    }

    fn receive(&mut self, deadline: Instant) -> Result<Value, String> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("the local Codex recommendation timed out".to_string());
        }
        match self.messages.recv_timeout(remaining) {
            Ok(Ok(message)) => Ok(message),
            Ok(Err(error)) => Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err("the local Codex recommendation timed out".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(self.exit_error()),
        }
    }

    fn decline_server_request(&mut self, message: &Value) -> Result<(), String> {
        let Some(id) = message.get("id").cloned() else {
            return Ok(());
        };
        self.send(&json!({
            "id": id,
            "error": {
                "code": -32601,
                "message": "Skill Advisor does not expose interactive tools"
            }
        }))
    }

    fn exit_error(&mut self) -> String {
        let status = self.child.try_wait().ok().flatten();
        let diagnostics = self
            .stderr
            .lock()
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        let status = status
            .map(|status| format!(" with status {status}"))
            .unwrap_or_default();
        if diagnostics.is_empty() {
            format!("Codex app-server stopped unexpectedly{status}")
        } else {
            format!("Codex app-server stopped unexpectedly{status}: {diagnostics}")
        }
    }
}

impl Drop for CodexAppServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn run_codex_advisor(
    fresh_prompt: &str,
    resumed_prompt: &str,
    existing_thread_id: Option<&str>,
    workspace: &Path,
) -> Result<CodexAdvisorOutput, String> {
    let deadline = Instant::now() + APP_SERVER_TIMEOUT;
    let mut server = CodexAppServer::spawn(workspace, deadline)?;
    let mut resumed = false;
    let thread_id = if let Some(thread_id) = existing_thread_id
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())
    {
        match server.request(
            2,
            "thread/resume",
            advisor_thread_resume_params(thread_id, workspace),
            deadline,
        ) {
            Ok(result) => {
                resumed = true;
                thread_id_from_result(&result)?
            }
            Err(_) => start_advisor_thread(&mut server, 3, workspace, deadline)?,
        }
    } else {
        start_advisor_thread(&mut server, 3, workspace, deadline)?
    };
    let prompt = if resumed {
        resumed_prompt
    } else {
        fresh_prompt
    };
    server.request(
        4,
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [{ "type": "text", "text": prompt }],
            "cwd": workspace.to_string_lossy(),
            "approvalPolicy": "never",
            "sandboxPolicy": advisor_turn_sandbox_policy(),
            "outputSchema": recommendation_output_schema()
        }),
        deadline,
    )?;
    let content = wait_for_turn(&mut server, deadline)?;
    Ok(CodexAdvisorOutput { content, thread_id })
}

pub fn delete_codex_advisor_thread(thread_id: &str, workspace: &Path) -> Result<(), String> {
    let thread_id = thread_id.trim();
    if thread_id.is_empty() {
        return Ok(());
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut server = CodexAppServer::spawn(workspace, deadline)?;
    server.request(
        2,
        "thread/delete",
        json!({ "threadId": thread_id }),
        deadline,
    )?;
    Ok(())
}

fn start_advisor_thread(
    server: &mut CodexAppServer,
    id: u64,
    workspace: &Path,
    deadline: Instant,
) -> Result<String, String> {
    let result = server.request(
        id,
        "thread/start",
        advisor_thread_start_params(workspace),
        deadline,
    )?;
    thread_id_from_result(&result)
}

fn advisor_thread_start_params(workspace: &Path) -> Value {
    json!({
        "cwd": workspace.to_string_lossy(),
        "approvalPolicy": "never",
        "sandbox": "read-only",
        "serviceName": "auto_gateway_skill_advisor"
    })
}

fn advisor_thread_resume_params(thread_id: &str, workspace: &Path) -> Value {
    json!({
        "threadId": thread_id,
        "cwd": workspace.to_string_lossy(),
        "approvalPolicy": "never",
        "sandbox": "read-only"
    })
}

fn advisor_turn_sandbox_policy() -> Value {
    json!({
        "type": "readOnly",
        "networkAccess": false
    })
}

fn thread_id_from_result(result: &Value) -> Result<String, String> {
    result
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex did not return a thread identifier".to_string())
}

fn wait_for_turn(server: &mut CodexAppServer, deadline: Instant) -> Result<String, String> {
    let mut final_message = None;
    let mut streamed_message = String::new();
    let mut runtime_error = None;
    loop {
        let message = server.next_message(deadline)?;
        if is_server_request(&message) {
            server.decline_server_request(&message)?;
            continue;
        }
        match message.get("method").and_then(Value::as_str) {
            Some("item/completed") => {
                let item = message.pointer("/params/item");
                if item
                    .and_then(|item| item.get("type"))
                    .and_then(Value::as_str)
                    == Some("agentMessage")
                {
                    if let Some(text) = item
                        .and_then(|item| item.get("text"))
                        .and_then(Value::as_str)
                    {
                        final_message = Some(text.to_string());
                    }
                }
            }
            Some("item/agentMessage/delta") => {
                if let Some(delta) = message.pointer("/params/delta").and_then(Value::as_str) {
                    streamed_message.push_str(delta);
                }
            }
            Some("error") => {
                runtime_error = message
                    .pointer("/params/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            Some("turn/completed") => {
                let status = message
                    .pointer("/params/turn/status")
                    .and_then(Value::as_str)
                    .unwrap_or("failed");
                if status != "completed" {
                    return Err(runtime_error.unwrap_or_else(|| {
                        format!("the local Codex turn finished with status {status}")
                    }));
                }
                let content = final_message
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(streamed_message);
                if content.trim().is_empty() {
                    return Err("the local Codex recommendation was empty".to_string());
                }
                return Ok(content);
            }
            _ => {}
        }
    }
}

fn recommendation_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "reply": { "type": "string" },
            "recommended_public_ids": {
                "type": "array",
                "items": { "type": "string" },
                "maxItems": 5
            },
            "needs_more_context": { "type": "boolean" }
        },
        "required": ["reply", "recommended_public_ids", "needs_more_context"],
        "additionalProperties": false
    })
}

fn is_server_request(message: &Value) -> bool {
    message.get("id").is_some() && message.get("method").is_some()
}

fn json_rpc_error(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("Codex app-server request failed: {error}"))
}

fn drain_diagnostics(mut input: impl Read, output: Arc<Mutex<String>>) {
    let mut buffer = [0_u8; 4096];
    loop {
        let Ok(read) = input.read(&mut buffer) else {
            break;
        };
        if read == 0 {
            break;
        }
        if let Ok(mut diagnostic) = output.lock() {
            diagnostic.push_str(&String::from_utf8_lossy(&buffer[..read]));
            if diagnostic.len() > MAX_DIAGNOSTIC_BYTES {
                let split_at = diagnostic.len() - MAX_DIAGNOSTIC_BYTES;
                diagnostic.drain(..split_at);
            }
        }
    }
}

fn codex_command_candidates() -> Vec<CodexCommand> {
    let mut candidates = Vec::new();
    for variable in ["AUTOGATEWAY_CODEX_BINARY", "CODEX_BINARY"] {
        if let Some(path) = std::env::var_os(variable).filter(|value| !value.is_empty()) {
            candidates.push(codex_command(PathBuf::from(path)));
        }
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let home = dirs::home_dir();
    #[cfg(target_os = "macos")]
    {
        for path in [
            "/Applications/ChatGPT.app/Contents/Resources/codex",
            "/Applications/ChatGPT.app/Contents/Resources/bin/codex",
            "/Applications/Codex.app/Contents/Resources/codex",
            "/Applications/Codex.app/Contents/Resources/bin/codex",
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
        ] {
            if Path::new(path).is_file() {
                candidates.push(codex_command(PathBuf::from(path)));
            }
        }
        if let Some(home) = &home {
            for suffix in [
                ".local/bin/codex",
                ".bun/bin/codex",
                ".volta/bin/codex",
                "Applications/ChatGPT.app/Contents/Resources/codex",
                "Applications/ChatGPT.app/Contents/Resources/bin/codex",
                "Applications/Codex.app/Contents/Resources/codex",
                "Applications/Codex.app/Contents/Resources/bin/codex",
            ] {
                let path = home.join(suffix);
                if path.is_file() {
                    candidates.push(codex_command(path));
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    if let Some(home) = &home {
        for suffix in [".local/bin/codex", ".bun/bin/codex", ".volta/bin/codex"] {
            let path = home.join(suffix);
            if path.is_file() {
                candidates.push(codex_command(path));
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(app_data) = std::env::var_os("APPDATA") {
            for name in ["codex.exe", "codex.cmd"] {
                let path = PathBuf::from(&app_data).join("npm").join(name);
                if path.is_file() {
                    candidates.push(codex_command(path));
                }
            }
        }
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let local_app_data = PathBuf::from(local_app_data);
            for application in ["ChatGPT", "Codex"] {
                let path = local_app_data
                    .join("Programs")
                    .join(application)
                    .join("resources")
                    .join("codex.exe");
                if path.is_file() {
                    candidates.push(codex_command(path));
                }
            }
        }
    }
    candidates.push(codex_command(PathBuf::from("codex")));
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|candidate| {
        let key = format!(
            "{}\0{:?}",
            candidate.program.to_string_lossy(),
            candidate.prefix_args
        );
        seen.insert(key)
    });
    candidates
}

fn codex_command(path: PathBuf) -> CodexCommand {
    #[cfg(target_os = "windows")]
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "cmd" | "bat"))
    {
        return CodexCommand {
            program: PathBuf::from("cmd.exe"),
            prefix_args: vec![
                OsString::from("/D"),
                OsString::from("/S"),
                OsString::from("/C"),
                path.into_os_string(),
            ],
        };
    }
    CodexCommand {
        program: path,
        prefix_args: Vec::new(),
    }
}

fn codex_process_path() -> OsString {
    let separator = if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    };
    let mut paths = std::env::var("PATH")
        .unwrap_or_default()
        .split(separator)
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = dirs::home_dir() {
            for suffix in [".local/bin", ".bun/bin", ".volta/bin"] {
                let path = home.join(suffix).to_string_lossy().to_string();
                if !paths.iter().any(|existing| existing == &path) {
                    paths.push(path);
                }
            }
        }
        for path in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            if !paths.iter().any(|existing| existing == path) {
                paths.push(path.to_string());
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(app_data) = std::env::var_os("APPDATA") {
            let path = PathBuf::from(app_data)
                .join("npm")
                .to_string_lossy()
                .to_string();
            if !paths.iter().any(|existing| existing == &path) {
                paths.push(path);
            }
        }
        for path in [r"C:\Program Files\nodejs", r"C:\Program Files (x86)\nodejs"] {
            if !paths.iter().any(|existing| existing == path) {
                paths.push(path.to_string());
            }
        }
    }
    OsString::from(paths.join(separator))
}

#[cfg(test)]
mod tests {
    use super::{
        advisor_thread_resume_params, advisor_thread_start_params, advisor_turn_sandbox_policy,
        json_rpc_error, recommendation_output_schema, start_advisor_thread, thread_id_from_result,
        wait_for_turn, CodexAppServer, CodexCommand,
    };
    use serde_json::json;
    use std::path::Path;
    use std::time::{Duration, Instant};

    #[test]
    fn reads_thread_identifier_from_app_server_response() {
        assert_eq!(
            thread_id_from_result(&json!({ "thread": { "id": "thr_advisor" } }))
                .expect("thread id"),
            "thr_advisor"
        );
    }

    #[test]
    fn recommendation_schema_rejects_extra_fields() {
        let schema = recommendation_output_schema();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(
            schema["properties"]["recommended_public_ids"]["maxItems"],
            5
        );
    }

    #[test]
    fn extracts_json_rpc_error_message() {
        assert_eq!(
            json_rpc_error(&json!({ "code": -1, "message": "not authenticated" })),
            "not authenticated"
        );
    }

    #[test]
    fn uses_legacy_read_only_sandbox_name_for_thread_requests() {
        let workspace = Path::new("/tmp/autogateway-skill-advisor");
        let start_params = advisor_thread_start_params(workspace);
        let resume_params = advisor_thread_resume_params("thr_advisor", workspace);

        assert_eq!(start_params["sandbox"], "read-only");
        assert_eq!(resume_params["sandbox"], "read-only");
    }

    #[test]
    fn uses_supported_read_only_policy_for_turn_requests() {
        let policy = advisor_turn_sandbox_policy();

        assert_eq!(policy["type"], "readOnly");
        assert_eq!(policy["networkAccess"], false);
        assert!(policy.get("access").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn exchanges_a_structured_turn_with_an_app_server_process() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join(format!(
            "autogateway-codex-advisor-protocol-{}",
            std::process::id()
        ));
        let script = directory.join("fake-codex");
        fs::create_dir_all(&directory).expect("create fake app-server directory");
        fs::write(
            &script,
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{"userAgent":"test"}}' ;;
    *'"method":"thread/start"'*) printf '%s\n' '{"id":2,"result":{"thread":{"id":"thr_test"}}}' ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn_test","status":"inProgress"}}}'
      printf '%s\n' '{"method":"item/completed","params":{"item":{"type":"agentMessage","text":"{\"reply\":\"Use it.\",\"recommended_public_ids\":[\"sk_test\"],\"needs_more_context\":false}"}}}'
      printf '%s\n' '{"method":"turn/completed","params":{"turn":{"id":"turn_test","status":"completed"}}}'
      ;;
  esac
done
"#,
        )
        .expect("write fake app-server");
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700))
            .expect("make fake app-server executable");
        let executable = CodexCommand {
            program: script,
            prefix_args: Vec::new(),
        };
        let mut server = CodexAppServer::spawn_with_command(&directory, &executable)
            .expect("start fake app-server");
        let deadline = Instant::now() + Duration::from_secs(5);
        server.initialize(deadline).expect("initialize app-server");
        let thread_id = start_advisor_thread(&mut server, 2, &directory, deadline)
            .expect("start advisor thread");
        assert_eq!(thread_id, "thr_test");
        server
            .request(
                3,
                "turn/start",
                json!({ "threadId": thread_id, "input": [] }),
                deadline,
            )
            .expect("start advisor turn");
        let output = wait_for_turn(&mut server, deadline).expect("complete advisor turn");
        assert!(output.contains("sk_test"));
        drop(server);
        fs::remove_dir_all(directory).expect("remove fake app-server directory");
    }
}
