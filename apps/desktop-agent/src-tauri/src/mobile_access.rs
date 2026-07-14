use anyhow::{bail, Context};
use qrcode::{render::svg, QrCode};
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MobileAccess {
    pub access_url: String,
    pub qr_svg: String,
    pub is_public: bool,
}

pub fn build_mobile_access(web_url: &str, device_id: &str) -> anyhow::Result<MobileAccess> {
    validate_device_id(device_id)?;

    let mut url = Url::parse(web_url.trim()).context("web URL is invalid")?;
    if !url.username().is_empty() || url.password().is_some() {
        bail!("web URL must not contain credentials");
    }

    let host = url.host_str().unwrap_or_default();
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host == "::1"
        || host.starts_with("127.");
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        bail!("remote web URL must use HTTPS");
    }

    url.set_query(None);
    url.set_fragment(Some(&format!("/device/{device_id}")));
    let access_url = url.to_string();
    let code = QrCode::new(access_url.as_bytes()).context("access URL is too long for a QR code")?;
    let rendered = code
        .render::<svg::Color<'_>>()
        .min_dimensions(232, 232)
        .dark_color(svg::Color("#111314"))
        .light_color(svg::Color("#f7f8f7"))
        .build();
    let qr_svg = rendered
        .strip_prefix(r#"<?xml version="1.0" standalone="yes"?>"#)
        .unwrap_or(&rendered)
        .to_owned();

    Ok(MobileAccess {
        access_url,
        qr_svg,
        is_public: !loopback && url.scheme() == "https",
    })
}

fn validate_device_id(device_id: &str) -> anyhow::Result<()> {
    if device_id.is_empty()
        || device_id.len() > 128
        || !device_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        || !device_id.as_bytes()[0].is_ascii_alphanumeric()
    {
        bail!("device ID is invalid");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_public_device_link_and_local_qr_svg() {
        let access = build_mobile_access(
            "https://codex.example.com/app?stale=1#/thread/old",
            "desktop-a:b",
        )
        .unwrap();

        assert_eq!(
            access.access_url,
            "https://codex.example.com/app#/device/desktop-a:b"
        );
        assert!(access.is_public);
        assert!(access.qr_svg.starts_with("<svg"));
        assert!(access.qr_svg.contains("viewBox"));
        assert!(!access.qr_svg.contains("pairing-secret"));
    }

    #[test]
    fn marks_loopback_links_as_local_preview_without_lan_rewriting() {
        let access = build_mobile_access("http://127.0.0.1:5900", "desktop-a").unwrap();

        assert_eq!(
            access.access_url,
            "http://127.0.0.1:5900/#/device/desktop-a"
        );
        assert!(!access.is_public);
    }

    #[test]
    fn rejects_unsafe_device_ids_and_insecure_remote_web_urls() {
        assert!(build_mobile_access("https://codex.example.com", "../desktop-a").is_err());
        assert!(build_mobile_access("http://codex.example.com", "desktop-a").is_err());
    }
}
