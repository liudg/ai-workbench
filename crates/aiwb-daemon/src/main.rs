#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

fn main() {
    let mut config = aiwb_daemon::Config::new(aiwb_core::data_dir());
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => config.data_dir = PathBuf::from(args.next().expect("--data-dir 缺少路径")),
            "--build" => config.build = args.next().expect("--build 缺少值"),
            "--port" => {
                config.port = args
                    .next()
                    .and_then(|port| port.parse().ok())
                    .expect("--port 需要端口号")
            }
            other => {
                eprintln!("未知参数：{other}");
                std::process::exit(2);
            }
        }
    }
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    if let Err(err) = runtime.block_on(aiwb_daemon::run(config)) {
        eprintln!("daemon 退出：{err}");
        std::process::exit(1);
    }
}
