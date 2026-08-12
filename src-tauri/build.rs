use std::{env, fs, path::PathBuf};

fn main() {
    tauri_build::build();

    let profile = env::var("PROFILE").unwrap_or_else(|_| "release".to_string());
    let environment = if profile == "debug" {
        "development"
    } else {
        "production"
    };
    let config_path = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(format!(".env.{environment}"));
    println!("cargo:rerun-if-changed={}", config_path.display());

    let config = fs::read_to_string(&config_path).unwrap_or_else(|error| {
        panic!(
            "failed to read {environment} desktop environment config at {}: {error}",
            config_path.display()
        )
    });
    for (config_key, rust_key) in [
        (
            "VITE_AUTO_GATEWAY_API_BASE_URL",
            "AUTO_GATEWAY_API_BASE_URL",
        ),
        (
            "VITE_AUTO_GATEWAY_CONSOLE_BASE_URL",
            "AUTO_GATEWAY_CONSOLE_BASE_URL",
        ),
    ] {
        let value = read_config_value(&config, config_key).unwrap_or_else(|| {
            panic!("missing {config_key} in {environment} desktop environment config")
        });
        println!("cargo:rustc-env={rust_key}={value}");
    }
}

fn read_config_value(config: &str, key: &str) -> Option<String> {
    config.lines().find_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let (line_key, value) = line.split_once('=')?;
        if line_key.trim() != key {
            return None;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        (!value.is_empty()).then(|| value.to_string())
    })
}
