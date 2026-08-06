use std::time::Duration;

pub fn desktop_user_agent() -> String {
    format!(
        "AUTO-Gateway-Desktop/{} ({}; {})",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

pub fn client() -> Result<reqwest::Client, String> {
    client_with_timeouts_and_read_timeout(
        Some(Duration::from_secs(30)),
        Some(Duration::from_secs(10)),
        Some(Duration::from_secs(30)),
    )
}

pub fn client_with_timeout(timeout: Option<Duration>) -> Result<reqwest::Client, String> {
    client_with_timeouts_and_read_timeout(timeout, timeout, timeout)
}

pub fn client_with_timeouts(
    timeout: Option<Duration>,
    connect_timeout: Option<Duration>,
) -> Result<reqwest::Client, String> {
    client_with_timeouts_and_read_timeout(timeout, connect_timeout, None)
}

pub fn client_with_timeouts_and_read_timeout(
    timeout: Option<Duration>,
    connect_timeout: Option<Duration>,
    read_timeout: Option<Duration>,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().user_agent(desktop_user_agent());
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    if let Some(connect_timeout) = connect_timeout {
        builder = builder.connect_timeout(connect_timeout);
    }
    if let Some(read_timeout) = read_timeout {
        builder = builder.read_timeout(read_timeout);
    }
    builder
        .build()
        .map_err(|error| format!("create desktop HTTP client: {error}"))
}

#[cfg(test)]
mod tests {
    use super::desktop_user_agent;

    #[test]
    fn desktop_user_agent_identifies_the_product_version_and_platform() {
        let user_agent = desktop_user_agent();
        assert!(user_agent.starts_with("AUTO-Gateway-Desktop/"));
        assert!(user_agent.contains(env!("CARGO_PKG_VERSION")));
        assert!(user_agent.contains(std::env::consts::OS));
        assert!(user_agent.contains(std::env::consts::ARCH));
    }
}
