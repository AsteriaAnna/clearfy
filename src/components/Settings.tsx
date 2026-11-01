import { useEffect, useState } from "react";
import { quotaStatus, quitApp, saveActivationCode, type QuotaStatus } from "../api";
import { THEMES, type Theme } from "../lib/theme";

export function Settings({
  theme,
  setTheme,
  onBack,
  onOpenTemplate,
}: {
  theme: Theme;
  setTheme: (t: Theme) => void;
  onBack: () => void;
  onOpenTemplate: (t: "a" | "b") => void;
}) {
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void quotaStatus().then(setQuota).catch(() => {});
  }, []);

  async function useCode() {
    try {
      const next = await saveActivationCode(code.trim());
      setQuota(next);
      setCode("");
      setMsg(next.code ? "激活码已生效" : "已清除激活码");
      setTimeout(() => setMsg(null), 3000);
    } catch (e) {
      setMsg(String(e));
    }
  }

  return (
    <main className="content settings">
      <h2>外观主题</h2>
      <div className="theme-cards">
        {THEMES.map((t) => (
          <button key={t.id} className={`theme-card theme-${t.id}${theme === t.id ? " on" : ""}`} onClick={() => setTheme(t.id)}>
            <span className="swatch" /><b>{t.label}</b>
          </button>
        ))}
      </div>

      <h2>视图</h2>
      <div className="set-card">
        <p className="muted">直接跳到 A 时间轴或 B 清单。</p>
        <div className="view-jump">
          <button className="jump" onClick={() => onOpenTemplate("a")}>
            <b>A</b><span>时间轴</span>
          </button>
          <button className="jump" onClick={() => onOpenTemplate("b")}>
            <b>B</b><span>清单</span>
          </button>
        </div>
      </div>

      <h2>额度</h2>
      <div className="set-card">
        <div className="field-row">
          <span>今日免费解析</span>
          <span className="pill ok">{quota ? `${quota.free_parse_left} / ${quota.free_parse_limit}` : "…"}</span>
        </div>
        <div className="field-row">
          <span>今日免费语音</span>
          <span className="pill ok">{quota ? `${quota.free_voice_left} / ${quota.free_voice_limit} 秒` : "…"}</span>
        </div>
        {quota?.code ? (
          <div className="field-row">
            <span>激活码额度</span>
            <span className="pill ok">
              解析 {quota.code.parse_left} 次 · 语音 {quota.code.voice_left} 秒
            </span>
          </div>
        ) : (
          <div className="field-row">
            <span>激活码</span>
            <span className="pill">未使用</span>
          </div>
        )}
        <label className="key-field">激活码
          <input value={code} placeholder="CLR1.…（可选）" onChange={(e) => setCode(e.target.value)} />
        </label>
        <div className="ai-actions">
          <button className="primary" onClick={() => void useCode()}>使用激活码</button>
          {msg && <span className="muted">{msg}</span>}
        </div>
        <p className="muted">语音与文字会经官方网关发送到豆包 / DeepSeek 处理；待办数据仍只存本机。</p>
      </div>

      <h2>窗口与退出</h2>
      <div className="set-card">
        <div className="field-row">
          <span>主窗 / 悬浮窗位置与尺寸</span>
          <span className="pill ok">自动记住</span>
        </div>
        <p className="muted">关闭主窗口只是隐藏，Clarify 会继续在悬浮窗运行。</p>
        <button className="danger-btn" onClick={() => void quitApp()}>退出 Clarify</button>
      </div>

      <h2>关于</h2>
      <div className="set-card">
        <p className="muted">Clarify · 本地运行 · 无账号 · 数据只在本机</p>
        <p className="muted">AI 由官方网关提供，开箱即用，无需配置 Key。</p>
        <p className="muted">全局快捷键：Ctrl+Alt+Space 文字捕捉 · Ctrl+Alt+V 语音捕捉（再按一次结束）</p>
      </div>

      <footer className="settings-footer">
        <button className="back-btn" onClick={onBack}>← 返回</button>
      </footer>
    </main>
  );
}
