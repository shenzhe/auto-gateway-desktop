use std::process::Command;
#[cfg(target_os = "macos")]
use std::process::Stdio;

pub const AUTO_GATEWAY_API_KEY_ENV: &str = "AUTO_GATEWAY_API_KEY";

#[cfg(target_os = "macos")]
const KEYCHAIN_ACCOUNT_SERVICE: &str = "cc.autogateway.codex.api-key";
#[cfg(target_os = "macos")]
const LAUNCH_AGENT_LABEL: &str = "cc.autogateway.codex-env";

/// Persist the gateway key for GUI-launched Codex processes.
///
/// The Codex provider reads the key from `AUTO_GATEWAY_API_KEY`. The key is
/// stored in the platform's user environment rather than config.toml or
/// auth.json, and the current process receives an immediate copy as well.
pub fn persist_api_key(api_key: &str) -> Result<(), String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("an AUTO Gateway API key is required".to_string());
    }

    #[cfg(target_os = "macos")]
    persist_macos_api_key(api_key)?;

    #[cfg(target_os = "windows")]
    persist_windows_api_key(api_key)?;

    // Explicitly update the current process as a fallback for applications
    // launched before the user-session environment has refreshed.
    std::env::set_var(AUTO_GATEWAY_API_KEY_ENV, api_key);
    Ok(())
}

/// Restore a missing current-process key from platform persistence.
///
/// This is intentionally best-effort at call sites such as status inspection:
/// a user may still be using the official OpenAI provider and need no gateway
/// key at all. When a persisted key exists, publish it explicitly as the
/// current-session fallback before returning.
pub fn ensure_api_key_available() -> Result<(), String> {
    if has_current_api_key() {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let api_key = read_macos_api_key()?.ok_or_else(|| {
            "AUTO_GATEWAY_API_KEY is not available in the current macOS session".to_string()
        })?;
        // Reinstall the persistence hook as well as restoring the current
        // session, so a missing LaunchAgent is repaired without reconfiguring.
        persist_macos_api_key(&api_key)?;
        std::env::set_var(AUTO_GATEWAY_API_KEY_ENV, api_key);
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        return Err(
            "AUTO_GATEWAY_API_KEY is not available in the current Windows session".to_string(),
        );
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("AUTO_GATEWAY_API_KEY is not available in the current session".to_string())
}

fn has_current_api_key() -> bool {
    std::env::var(AUTO_GATEWAY_API_KEY_ENV)
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
}

#[cfg(target_os = "macos")]
fn persist_macos_api_key(api_key: &str) -> Result<(), String> {
    let account = current_macos_account()?;
    let home = dirs::home_dir()
        .ok_or_else(|| "unable to determine the macOS user home directory".to_string())?;
    let launch_agent_directory = home.join("Library").join("LaunchAgents");
    let launch_agent_path = launch_agent_directory.join(format!("{LAUNCH_AGENT_LABEL}.plist"));
    let user_domain = format!("gui/{}", current_macos_uid()?);

    run_silent(
        Command::new("/usr/bin/security").args([
            "add-generic-password",
            "-U",
            "-a",
            &account,
            "-s",
            KEYCHAIN_ACCOUNT_SERVICE,
            "-w",
            api_key,
        ]),
        "store the AUTO Gateway API key in macOS Keychain",
    )?;

    std::fs::create_dir_all(&launch_agent_directory)
        .map_err(|error| format!("create the macOS LaunchAgents directory: {error}"))?;
    write_launch_agent(&launch_agent_path)?;

    let service = format!("{user_domain}/{LAUNCH_AGENT_LABEL}");
    run_silent(
        Command::new("/bin/launchctl").args(["bootout", &service]),
        "unload the previous AUTO Gateway macOS LaunchAgent",
    )
    .ok();
    let launch_agent_path = path_string(&launch_agent_path);
    run_silent(
        Command::new("/bin/launchctl").args(["bootstrap", &user_domain, &launch_agent_path]),
        "load the AUTO Gateway macOS LaunchAgent",
    )?;
    run_silent(
        Command::new("/bin/launchctl").args(["kickstart", "-k", &service]),
        "start the AUTO Gateway macOS LaunchAgent",
    )?;

    // Keep the explicit write from the latest ai_gateway script as the
    // immediate fallback even when the LaunchAgent has not run yet.
    set_macos_session_environment(api_key)
}

#[cfg(target_os = "macos")]
fn set_macos_session_environment(api_key: &str) -> Result<(), String> {
    run_silent(
        Command::new("/bin/launchctl").args(["setenv", AUTO_GATEWAY_API_KEY_ENV, api_key]),
        "write the AUTO Gateway API key to the current macOS session",
    )
}

#[cfg(target_os = "macos")]
fn read_macos_api_key() -> Result<Option<String>, String> {
    let account = current_macos_account()?;
    let output = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-a",
            &account,
            "-s",
            KEYCHAIN_ACCOUNT_SERVICE,
            "-w",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|error| format!("read the AUTO Gateway API key from macOS Keychain: {error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let api_key = String::from_utf8(output.stdout)
        .map_err(|error| format!("decode the macOS Keychain API key: {error}"))?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Ok(None);
    }
    Ok(Some(api_key.to_string()))
}

#[cfg(target_os = "macos")]
fn write_launch_agent(path: &std::path::Path) -> Result<(), String> {
    const PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>cc.autogateway.codex-env</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>key=&quot;$(/usr/bin/security find-generic-password -a &quot;$(/usr/bin/id -un)&quot; -s &quot;cc.autogateway.codex.api-key&quot; -w 2&gt;/dev/null)&quot;; [ -n &quot;$key&quot; ] &amp;&amp; /bin/launchctl setenv AUTO_GATEWAY_API_KEY &quot;$key&quot;</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#;
    let temporary = path.with_extension(format!("plist.{}.tmp", std::process::id()));
    std::fs::write(&temporary, PLIST)
        .map_err(|error| format!("write the AUTO Gateway macOS LaunchAgent: {error}"))?;
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!(
            "install the AUTO Gateway macOS LaunchAgent: {error}"
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn current_macos_account() -> Result<String, String> {
    let output = Command::new("/usr/bin/id")
        .arg("-un")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|error| format!("read the macOS account name: {error}"))?;
    if !output.status.success() {
        return Err("read the macOS account name".to_string());
    }
    let account = String::from_utf8(output.stdout)
        .map_err(|error| format!("decode the macOS account name: {error}"))?;
    let account = account.trim();
    if account.is_empty() {
        return Err("the macOS account name is empty".to_string());
    }
    Ok(account.to_string())
}

#[cfg(target_os = "macos")]
fn current_macos_uid() -> Result<String, String> {
    let output = Command::new("/usr/bin/id")
        .arg("-u")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|error| format!("read the macOS user ID: {error}"))?;
    if !output.status.success() {
        return Err("read the macOS user ID".to_string());
    }
    let uid = String::from_utf8(output.stdout)
        .map_err(|error| format!("decode the macOS user ID: {error}"))?;
    let uid = uid.trim();
    if uid.is_empty() {
        return Err("the macOS user ID is empty".to_string());
    }
    Ok(uid.to_string())
}

#[cfg(target_os = "macos")]
fn path_string(path: &std::path::Path) -> String {
    path.display().to_string()
}

#[cfg(target_os = "windows")]
fn persist_windows_api_key(api_key: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const SCRIPT: &str = r#"
[Environment]::SetEnvironmentVariable(
  'AUTO_GATEWAY_API_KEY',
  $env:AUTO_GATEWAY_API_KEY,
  [EnvironmentVariableTarget]::User
)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AutoGatewayEnvironmentBroadcast {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        uint message,
        UIntPtr wParam,
        string lParam,
        uint flags,
        uint timeout,
        out UIntPtr result);
}
'@
$result = [UIntPtr]::Zero
[AutoGatewayEnvironmentBroadcast]::SendMessageTimeout(
  [IntPtr]0xffff,
  0x001a,
  [UIntPtr]::Zero,
  'Environment',
  0x0002,
  5000,
  [ref]$result
) | Out-Null
"#;

    let status = Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .env(AUTO_GATEWAY_API_KEY_ENV, api_key)
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .status()
        .map_err(|error| format!("publish the AUTO Gateway API key to Windows: {error}"))?;
    if !status.success() {
        return Err(format!(
            "publish the AUTO Gateway API key to Windows (exit status: {})",
            status
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn run_silent(command: &mut Command, action: &str) -> Result<(), String> {
    let status = command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("{action}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{action} (exit status: {status})"))
    }
}
