use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use axecode_core::KernelSnapshot;
use axecode_repl::{python, HostHandler, Kernel, KernelSpec};

struct Echo;

#[async_trait]
impl HostHandler for Echo {
    async fn call(&self, method: &str, params: Value, _exec: Option<String>) -> Result<Value, String> {
        if method == "test.fail" {
            return Err("nope".into());
        }
        Ok(json!({"method": method, "params": params}))
    }
}

async fn start() -> Option<Arc<Kernel>> {
    let python = python::find_python(&[])?;
    let package_dir = python::find_package_dir(&[])?;
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let spec = KernelSpec {
        python,
        package_dir,
        workspace: std::env::temp_dir(),
        session_id: "test".into(),
        modules: json!({}),
        sys_path: vec![],
        env: vec![],
    };
    match Kernel::start(spec, Arc::new(Echo), tx).await {
        Ok(kernel) => Some(kernel),
        Err(err) => {
            eprintln!("skipping kernel test: {err}");
            None
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_ends_a_cell_blocked_in_a_child_process() {
    let Some(kernel) = start().await else { return };
    let exec = {
        let kernel = kernel.clone();
        tokio::spawn(async move {
            kernel
                .exec("1", "import subprocess, sys\nsubprocess.run([sys.executable, '-c', 'import time; time.sleep(60)'])")
                .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    kernel.kill().await;
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), exec)
        .await
        .expect("exec returns after kill")
        .unwrap();
    assert!(result.is_err());
    assert!(!kernel.is_alive());
}

#[tokio::test(flavor = "multi_thread")]
async fn exec_rpc_snapshot_roundtrip() {
    let Some(kernel) = start().await else { return };
    let result = kernel.exec("1", "x = 41\nprint('hello')\nx + 1").await.unwrap();
    assert_eq!(result.stdout, "hello\n");
    assert_eq!(result.value.as_deref(), Some("42"));
    assert!(result.error.is_none());

    let result = kernel
        .exec("2", "from axecode_kernel import bridge\nbridge.call('test.echo', {'a': 1})['params']['a']")
        .await
        .unwrap();
    assert_eq!(result.value.as_deref(), Some("1"), "{result:?}");

    let result = kernel
        .exec("3", "from axecode_kernel import bridge\nbridge.call('test.fail')")
        .await
        .unwrap();
    assert!(result.error.as_deref().unwrap_or("").contains("nope"));

    let snapshot = kernel.save().await.unwrap();
    kernel.exec("4", "del x").await.unwrap();
    kernel.restore(&snapshot).await.unwrap();
    let result = kernel.exec("5", "x").await.unwrap();
    assert_eq!(result.value.as_deref(), Some("41"));

    let removed = kernel.collect(vec![]).await.unwrap();
    assert!(removed.contains(&"x".to_string()));
    kernel.shutdown().await;
    assert!(!kernel.is_alive() || kernel.exec("6", "1").await.is_err());
}

/// Stop must not leave the programs started by the kernel running (a
/// `shell.session()`, a `subprocess.Popen`): `kill` ends its process group.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn kill_ends_the_programs_the_kernel_started() {
    let Some(kernel) = start().await else { return };
    let result = kernel
        .exec("1", "import subprocess\np = subprocess.Popen(['sleep', '60'])\nprint(p.pid)")
        .await
        .unwrap();
    let pid: u32 = result.stdout.trim().parse().expect("child pid");
    assert!(running(pid), "child {pid} did not start");
    kernel.kill().await;
    for _ in 0..100 {
        if !running(pid) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("child {pid} survived the kernel kill");
}

/// Alive and not a zombie (Linux /proc).
#[cfg(target_os = "linux")]
fn running(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat.rsplit(')').next().and_then(|rest| rest.split_whitespace().next()) != Some("Z"),
        Err(_) => false,
    }
}
