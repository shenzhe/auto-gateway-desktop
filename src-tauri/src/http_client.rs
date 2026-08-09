use std::time::Duration;

fn desktop_user_agent_token() -> String {
    format!("AUTO-Gateway-Desktop/{}", env!("CARGO_PKG_VERSION"))
}

pub fn desktop_user_agent() -> String {
    format!(
        "autogateway-desktop/{} {} ({}; {})",
        env!("CARGO_PKG_VERSION"),
        desktop_user_agent_token(),
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

pub fn desktop_user_agent_for_webview(original_user_agent: Option<&str>) -> String {
    let original_user_agent = original_user_agent
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("autogateway-desktop/{}", env!("CARGO_PKG_VERSION")));
    format!("{original_user_agent} {}", desktop_user_agent_token())
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
    use super::{desktop_user_agent, desktop_user_agent_for_webview};

    #[test]
    fn desktop_user_agent_preserves_the_original_product_identity() {
        let user_agent = desktop_user_agent();
        assert!(user_agent.starts_with("autogateway-desktop/"));
        assert!(user_agent.contains(env!("CARGO_PKG_VERSION")));
        assert!(user_agent.contains("AUTO-Gateway-Desktop/"));
        assert!(user_agent.contains(std::env::consts::OS));
        assert!(user_agent.contains(std::env::consts::ARCH));
    }

    #[test]
    fn webview_user_agent_appends_to_the_original_value() {
        let original = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
        let user_agent = desktop_user_agent_for_webview(Some(original));

        assert_eq!(
            user_agent,
            format!(
                "{original} AUTO-Gateway-Desktop/{}",
                env!("CARGO_PKG_VERSION")
            )
        );
    }
}
