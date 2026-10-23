//! Local socket transport: named pipes on Windows, unix sockets elsewhere.

use std::{io, pin::Pin};

use tokio::io::{AsyncRead, AsyncWrite};

pub trait Stream: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Stream for T {}

pub type BoxStream = Pin<Box<dyn Stream>>;

/// Connects to a daemon endpoint.
pub async fn connect(endpoint: &str) -> io::Result<BoxStream> {
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        let mut attempts = 0;
        loop {
            match ClientOptions::new().open(endpoint) {
                Ok(client) => return Ok(Box::pin(client)),
                // All pipe instances busy: retry shortly.
                Err(err) if err.raw_os_error() == Some(231) && attempts < 20 => {
                    attempts += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                Err(err) => return Err(err),
            }
        }
    }
    #[cfg(not(windows))]
    {
        let stream = tokio::net::UnixStream::connect(endpoint).await?;
        Ok(Box::pin(stream))
    }
}

/// Server side listener.
pub struct Listener {
    endpoint: String,
    #[cfg(windows)]
    next: Option<tokio::net::windows::named_pipe::NamedPipeServer>,
    #[cfg(not(windows))]
    inner: tokio::net::UnixListener,
}

impl Listener {
    pub fn bind(endpoint: &str) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use tokio::net::windows::named_pipe::ServerOptions;
            let first = ServerOptions::new()
                .first_pipe_instance(true)
                .create(endpoint)?;
            Ok(Self {
                endpoint: endpoint.to_string(),
                next: Some(first),
            })
        }
        #[cfg(not(windows))]
        {
            let path = std::path::Path::new(endpoint);
            if path.exists() {
                // Stale socket from a dead daemon (the lock check happens before).
                let _ = std::fs::remove_file(path);
            }
            let inner = tokio::net::UnixListener::bind(path)?;
            Ok(Self {
                endpoint: endpoint.to_string(),
                inner,
            })
        }
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub async fn accept(&mut self) -> io::Result<BoxStream> {
        #[cfg(windows)]
        {
            use tokio::net::windows::named_pipe::ServerOptions;
            let server = match self.next.take() {
                Some(server) => server,
                None => ServerOptions::new().create(&self.endpoint)?,
            };
            server.connect().await?;
            // Prepare the next instance before handing this one out so that
            // clients never see "pipe not found" between two accepts.
            self.next = Some(ServerOptions::new().create(&self.endpoint)?);
            Ok(Box::pin(server))
        }
        #[cfg(not(windows))]
        {
            let (stream, _) = self.inner.accept().await?;
            Ok(Box::pin(stream))
        }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        #[cfg(not(windows))]
        {
            let _ = std::fs::remove_file(&self.endpoint);
        }
    }
}
