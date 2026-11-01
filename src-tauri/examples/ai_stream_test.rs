//! 临时联调：验证豆包流式 ASR（PCM 16k/16bit/mono，Key 从环境变量读取）。
//! 运行：$env:CLARIFY_DOUBAO_KEY="..."; $env:CLARIFY_PCM_FILE="..."; cargo run -p clarify --example ai_stream_test

fn main() {
    tauri::async_runtime::block_on(async {
        let key = std::env::var("CLARIFY_DOUBAO_KEY").expect("需要 CLARIFY_DOUBAO_KEY");
        let path = std::env::var("CLARIFY_PCM_FILE").expect("需要 CLARIFY_PCM_FILE");
        let pcm = std::fs::read(path).expect("读取 PCM 失败");
        println!("pcm bytes={}", pcm.len());
        let text = clarify_lib::ai::stream_transcribe(&pcm, &key)
            .await
            .expect("stream transcribe failed");
        println!("TEXT={text}");
    });
}
