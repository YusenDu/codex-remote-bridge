use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use url::Url;

const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/YusenDu/codex-remote-bridge/releases/latest";
const RELEASE_PATH_PREFIX: &str = "/YusenDu/codex-remote-bridge/releases/tag/";

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    published_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusView {
    current_version: String,
    latest_version: String,
    update_available: bool,
    release_url: String,
    published_at: Option<String>,
}

fn parse_release_version(value: &str) -> Result<(u64, u64, u64), String> {
    let normalized = value.trim().strip_prefix('v').unwrap_or(value.trim());
    let components = normalized.split('.').collect::<Vec<_>>();
    if components.len() != 3 {
        return Err(format!("Unsupported release version: {value}"));
    }
    let parse = |component: &str| {
        component
            .parse::<u64>()
            .map_err(|_| format!("Unsupported release version: {value}"))
    };
    Ok((
        parse(components[0])?,
        parse(components[1])?,
        parse(components[2])?,
    ))
}

fn is_newer_release(current: &str, latest_tag: &str) -> Result<bool, String> {
    Ok(parse_release_version(latest_tag)? > parse_release_version(current)?)
}

fn build_update_status(
    current_version: &str,
    release: GitHubRelease,
) -> Result<UpdateStatusView, String> {
    let release_url = validate_release_url(&release.html_url)?;
    let latest_version = release.tag_name.trim_start_matches('v').to_owned();
    Ok(UpdateStatusView {
        current_version: current_version.to_owned(),
        latest_version,
        update_available: is_newer_release(current_version, &release.tag_name)?,
        release_url: release_url.to_string(),
        published_at: release.published_at,
    })
}

pub async fn check_for_update(current_version: &str) -> Result<UpdateStatusView, String> {
    parse_release_version(current_version)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(format!("Codex-Bridge-Agent/{current_version}"))
        .build()
        .map_err(|error| error.to_string())?;
    let release = client
        .get(LATEST_RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("Unable to reach GitHub Releases: {error}"))?
        .error_for_status()
        .map_err(|error| format!("GitHub Releases returned an error: {error}"))?
        .json::<GitHubRelease>()
        .await
        .map_err(|error| format!("Invalid GitHub Release response: {error}"))?;
    build_update_status(current_version, release)
}

pub fn validate_release_url(value: &str) -> Result<Url, String> {
    let parsed = Url::parse(value).map_err(|_| "Release URL is invalid".to_owned())?;
    let valid = parsed.scheme() == "https"
        && parsed.host_str() == Some("github.com")
        && parsed.path().starts_with(RELEASE_PATH_PREFIX)
        && parsed.query().is_none()
        && parsed.fragment().is_none();
    if !valid {
        return Err("Release URL is not an approved Codex Remote Bridge release".to_owned());
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_release_versions_without_treating_older_tags_as_updates() {
        assert!(is_newer_release("0.1.89", "v0.1.90").unwrap());
        assert!(!is_newer_release("0.1.90", "v0.1.90").unwrap());
        assert!(!is_newer_release("0.1.91", "v0.1.90").unwrap());
        assert!(is_newer_release("0.1.90", "latest").is_err());
    }

    #[test]
    fn maps_the_latest_release_to_a_safe_update_status() {
        let status = build_update_status(
            "0.1.89",
            GitHubRelease {
                tag_name: "v0.1.90".into(),
                html_url:
                    "https://github.com/YusenDu/codex-remote-bridge/releases/tag/v0.1.90".into(),
                published_at: Some("2026-07-14T00:00:00Z".into()),
            },
        )
        .unwrap();

        assert!(status.update_available);
        assert_eq!(status.current_version, "0.1.89");
        assert_eq!(status.latest_version, "0.1.90");
    }

    #[test]
    fn accepts_only_this_projects_https_release_pages() {
        assert!(validate_release_url(
            "https://github.com/YusenDu/codex-remote-bridge/releases/tag/v0.1.90"
        )
        .is_ok());
        assert!(validate_release_url(
            "http://github.com/YusenDu/codex-remote-bridge/releases/tag/v0.1.90"
        )
        .is_err());
        assert!(validate_release_url("https://example.com/releases/tag/v0.1.90").is_err());
    }
}
