//! 临时联调：验证 DeepSeek 解析链路（Key 从环境变量读取，不写入仓库）。
//! 运行：$env:CLARIFY_DEEPSEEK_KEY="sk-..."; cargo run -p clarify --example ai_parse_test

fn main() {
    tauri::async_runtime::block_on(async {
        let key = std::env::var("CLARIFY_DEEPSEEK_KEY").expect("需要 CLARIFY_DEEPSEEK_KEY 环境变量");
        let (now, offset) = clarify_lib::ai::now_local_strings();
        println!("now={now} offset={offset}");
        let tasks = clarify_lib::ai::deepseek_parse(
            "明天下午三点跟张总开会，顺便买牛奶",
            &now,
            offset,
            &key,
        )
        .await
        .expect("deepseek parse failed");
        println!("tasks={}", tasks.len());
        for t in tasks {
            println!(
                "title={:?} date={:?} start={:?} end={:?} repeat={:?} count={:?}",
                t.title, t.due_date, t.due_start_at, t.due_end_at, t.repeat_freq, t.count_target
            );
        }
    });
}
