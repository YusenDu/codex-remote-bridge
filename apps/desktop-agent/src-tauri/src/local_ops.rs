use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const MAX_REMOTE_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

pub async fn execute(method: &str, params: Value) -> Option<Result<Value>> {
    match method {
        "codex-web/local/project-root-suggestion" => Some(project_root_suggestion(&params)),
        "codex-web/local/worktree-branches" => Some(worktree_branches(&params)),
        "codex-web/local/git-branches" => Some(git_branches(&params)),
        "codex-web/local/read-image-file" => Some(read_image_file(&params)),
        _ if method.starts_with("codex-web/local/") => {
            Some(Err(anyhow::anyhow!("local operation is unsupported")))
        }
        _ => None,
    }
}

fn read_image_file(params: &Value) -> Result<Value> {
    let path = required_path(params, "path")?;
    let metadata = fs::metadata(&path).context("image file does not exist")?;
    if !metadata.is_file() {
        bail!("image path is not a regular file");
    }
    if metadata.len() == 0 || metadata.len() > MAX_REMOTE_IMAGE_BYTES {
        bail!("image file is empty or too large");
    }
    let bytes = fs::read(&path).context("failed to read image file")?;
    let content_type = detect_image_content_type(&bytes)
        .context("unsupported image file")?;
    Ok(json!({
        "data": BASE64_STANDARD.encode(&bytes),
        "contentType": content_type,
        "size": bytes.len(),
    }))
}

fn detect_image_content_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis")
    {
        return Some("image/avif");
    }
    None
}

fn worktree_branches(params: &Value) -> Result<Value> {
    let source_cwd = required_directory(params, "sourceCwd")?;
    let Some(git_root) = git_root_or_none(&source_cwd)? else {
        return Ok(json!([]));
    };
    let output = git_output(
        &git_root,
        &[
            "for-each-ref",
            "--format=%(committerdate:unix)\t%(refname)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let mut activity = HashMap::<String, i64>::new();
    for line in output.lines() {
        let mut fields = line.splitn(2, '\t');
        let timestamp = fields
            .next()
            .unwrap_or_default()
            .trim()
            .parse()
            .unwrap_or(0);
        let name = normalize_branch_ref(fields.next().unwrap_or_default());
        if name.is_empty() || name == "origin/HEAD" {
            continue;
        }
        activity
            .entry(name)
            .and_modify(|current| *current = (*current).max(timestamp))
            .or_insert(timestamp);
    }
    let mut branches = activity
        .iter()
        .map(|(name, timestamp)| (name.clone(), *timestamp))
        .collect::<Vec<_>>();
    branches.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    Ok(Value::Array(
        branches
            .into_iter()
            .map(|(name, _)| json!({ "value": name, "label": name }))
            .collect(),
    ))
}

fn git_branches(params: &Value) -> Result<Value> {
    let cwd = required_directory(params, "cwd")?;
    let Some(git_root) = git_root_or_none(&cwd)? else {
        return Ok(json!({ "currentBranch": null, "options": [] }));
    };
    let current_branch = git_output(&git_root, &["branch", "--show-current"])?;
    let current_branch = non_empty(&current_branch);
    let head_sha = non_empty(&git_output(
        &git_root,
        &["rev-parse", "--short=12", "HEAD"],
    )?);
    let head = git_output(
        &git_root,
        &["show", "-s", "--date=short", "--format=%cd%x09%s", "HEAD"],
    )?;
    let mut head_fields = head.splitn(2, '\t');
    let head_date = non_empty(head_fields.next().unwrap_or_default());
    let head_subject = non_empty(head_fields.next().unwrap_or_default());
    let dirty = !git_output(&git_root, &["status", "--porcelain"])?.is_empty();
    let refs = git_output(
        &git_root,
        &[
            "for-each-ref",
            "--format=%(committerdate:unix)\t%(refname)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let mut activity = HashMap::<String, (i64, bool)>::new();
    for line in refs.lines() {
        let mut fields = line.splitn(2, '\t');
        let timestamp = fields
            .next()
            .unwrap_or_default()
            .trim()
            .parse()
            .unwrap_or(0);
        let raw_ref = fields.next().unwrap_or_default().trim();
        let name = normalize_branch_ref(raw_ref);
        if name.is_empty() || name == "origin/HEAD" {
            continue;
        }
        let remote = raw_ref.starts_with("refs/remotes/");
        activity
            .entry(name)
            .and_modify(|current| {
                if timestamp > current.0 {
                    *current = (timestamp, remote);
                }
            })
            .or_insert((timestamp, remote));
    }
    if let Some(branch) = &current_branch {
        activity.entry(branch.clone()).or_insert((i64::MAX, false));
    }
    let mut branches = activity
        .into_iter()
        .map(|(name, (timestamp, remote))| (name, timestamp, remote))
        .collect::<Vec<_>>();
    branches.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    let options = branches
        .into_iter()
        .map(|(name, _, remote)| {
            json!({
                "value": name,
                "label": name,
                "isCurrent": current_branch.as_deref() == Some(name.as_str()),
                "isRemote": remote,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "currentBranch": current_branch,
        "headSha": head_sha,
        "headSubject": head_subject,
        "headDate": head_date,
        "detached": current_branch.is_none(),
        "dirty": dirty,
        "gitRoot": git_root.to_string_lossy(),
        "options": options,
    }))
}

fn project_root_suggestion(params: &Value) -> Result<Value> {
    let base_path = required_path(params, "basePath")?;
    if !base_path.is_dir() {
        bail!("basePath does not exist or is not a directory");
    }
    for index in 1..100_000 {
        let name = format!("New Project ({index})");
        let path = base_path.join(&name);
        if !path.exists() {
            return Ok(json!({ "name": name, "path": path.to_string_lossy() }));
        }
    }
    bail!("failed to compute project name suggestion")
}

fn required_path(params: &Value, key: &str) -> Result<PathBuf> {
    let raw = params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .with_context(|| format!("missing {key}"))?;
    let path = Path::new(raw);
    if !path.is_absolute() {
        bail!("{key} must be an absolute path");
    }
    Ok(path.to_path_buf())
}

fn required_directory(params: &Value, key: &str) -> Result<PathBuf> {
    let path = required_path(params, key)?;
    if !path.is_dir() {
        bail!("{key} does not exist or is not a directory");
    }
    Ok(path)
}

fn git_root_or_none(cwd: &Path) -> Result<Option<PathBuf>> {
    match git_output(cwd, &["rev-parse", "--show-toplevel"]) {
        Ok(root) => Ok(Some(PathBuf::from(root))),
        Err(error)
            if error
                .to_string()
                .to_lowercase()
                .contains("not a git repository") =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn git_output(cwd: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .with_context(|| format!("failed to start git {}", args.join(" ")))?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        bail!("git {} failed: {details}", args.join(" "));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn normalize_branch_ref(value: &str) -> String {
    value
        .trim()
        .strip_prefix("refs/heads/")
        .or_else(|| value.trim().strip_prefix("refs/remotes/"))
        .unwrap_or(value.trim())
        .to_owned()
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .unwrap();
        assert!(status.success(), "git command failed: {args:?}");
    }

    fn repository() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "-b", "main"]);
        git(root.path(), &["config", "user.email", "test@example.com"]);
        git(root.path(), &["config", "user.name", "Test User"]);
        fs::write(root.path().join("README.md"), "hello\n").unwrap();
        git(root.path(), &["add", "README.md"]);
        git(root.path(), &["commit", "-m", "Initial commit"]);
        git(root.path(), &["branch", "feature"]);
        root
    }

    #[tokio::test]
    async fn suggests_a_unique_project_folder_on_the_desktop() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("New Project (1)")).unwrap();

        let result = execute(
            "codex-web/local/project-root-suggestion",
            json!({ "basePath": root.path() }),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(result["name"], "New Project (2)");
        assert_eq!(
            result["path"],
            root.path()
                .join("New Project (2)")
                .to_string_lossy()
                .as_ref()
        );
    }

    #[tokio::test]
    async fn leaves_regular_codex_rpc_methods_for_the_cdp_bridge() {
        assert!(execute("thread/read", json!({ "threadId": "thread-a" }))
            .await
            .is_none());
    }

    #[tokio::test]
    async fn reads_a_bounded_png_for_the_remote_web_preview() {
        let root = tempfile::tempdir().unwrap();
        let image_path = root.path().join("screenshot.png");
        let bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        fs::write(&image_path, bytes).unwrap();

        let result = execute(
            "codex-web/local/read-image-file",
            json!({ "path": image_path }),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(result["contentType"], "image/png");
        assert_eq!(result["size"], bytes.len());
        assert_eq!(result["data"], "iVBORw0KGgo=");
    }

    #[tokio::test]
    async fn rejects_non_image_files_from_remote_preview_reads() {
        let root = tempfile::tempdir().unwrap();
        let text_path = root.path().join("secrets.txt");
        fs::write(&text_path, "not an image").unwrap();

        let error = execute(
            "codex-web/local/read-image-file",
            json!({ "path": text_path }),
        )
        .await
        .unwrap()
        .unwrap_err();

        assert!(error.to_string().contains("unsupported image"));
    }

    #[tokio::test]
    async fn lists_worktree_branches_from_the_local_repository() {
        let root = repository();

        let result = execute(
            "codex-web/local/worktree-branches",
            json!({ "sourceCwd": root.path() }),
        )
        .await
        .unwrap()
        .unwrap();

        let values = result
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|entry| entry["value"].as_str())
            .collect::<Vec<_>>();
        assert!(values.contains(&"main"));
        assert!(values.contains(&"feature"));
    }

    #[tokio::test]
    async fn reads_git_branch_state_from_the_local_repository() {
        let root = repository();

        let result = execute(
            "codex-web/local/git-branches",
            json!({ "cwd": root.path() }),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(result["currentBranch"], "main");
        assert_eq!(result["detached"], false);
        assert_eq!(result["dirty"], false);
        assert!(result["headSha"]
            .as_str()
            .is_some_and(|value| value.len() == 12));
        assert!(result["options"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["value"] == "feature"));
    }
}
