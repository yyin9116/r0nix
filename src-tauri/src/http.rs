use std::time::Duration;

pub(crate) async fn read_capped_body(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let limit_label = max_bytes / 1024 / 1024;
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(format!("response exceeds {limit_label} MiB limit"));
    }

    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("read response bytes failed: {err}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!("response exceeds {limit_label} MiB limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(crate) fn build_http_client(
    timeout: Duration,
    redirects: usize,
    proxy: Option<&str>,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(redirects))
        .timeout(timeout)
        .danger_accept_invalid_certs(false);
    if let Some(proxy_url) = proxy {
        let trimmed = proxy_url.trim();
        if !trimmed.is_empty() {
            let proxy =
                reqwest::Proxy::all(trimmed).map_err(|err| format!("invalid proxy url: {err}"))?;
            builder = builder.proxy(proxy);
        }
    }
    builder
        .build()
        .map_err(|err| format!("failed to create HTTP client: {err}"))
}

#[cfg(test)]
mod tests {
    use super::{build_http_client, read_capped_body};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn response_with_body(headers: &str, body: &str) -> reqwest::Response {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local test server");
        let address = listener.local_addr().expect("read local test address");
        let headers = headers.to_string();
        let body = body.to_string();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept local request");
            let mut request = [0; 1024];
            let _ = stream.read(&mut request).await;
            stream
                .write_all(format!("HTTP/1.1 200 OK\r\n{headers}\r\n\r\n{body}").as_bytes())
                .await
                .expect("write local response");
        });
        reqwest::Client::new()
            .get(format!("http://{address}/"))
            .send()
            .await
            .expect("request local response")
    }

    #[tokio::test]
    async fn rejects_declared_body_larger_than_limit() {
        let response = response_with_body("Content-Length: 6\r\nConnection: close", "abcdef").await;
        let error = read_capped_body(response, 5).await.unwrap_err();
        assert!(error.contains("response exceeds"));
    }

    #[tokio::test]
    async fn rejects_chunked_body_larger_than_limit() {
        let response = response_with_body(
            "Transfer-Encoding: chunked\r\nConnection: close",
            "6\r\nabcdef\r\n0\r\n\r\n",
        )
        .await;
        let error = read_capped_body(response, 5).await.unwrap_err();
        assert!(error.contains("response exceeds"));
    }

    #[test]
    fn rejects_invalid_proxy_configuration() {
        let error =
            build_http_client(Duration::from_secs(1), 3, Some("not a proxy url")).unwrap_err();
        assert!(error.starts_with("invalid proxy url:"));
    }
}
