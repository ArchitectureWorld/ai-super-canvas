const foundations = [
  '统一工作台，而不是多个页面拼接',
  '语义锚点、分枝、回流与代谢',
  'Linux / NAS Docker 优先部署',
];

export default function HomePage() {
  return (
    <main className="shell">
      <header className="topbar">
        <span className="brand">AI Super Canvas</span>
        <span className="phase">Feature 01 · Scaffold</span>
      </header>

      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Unified Organic Workspace</p>
        <h1 id="page-title">让 AI 会话从线性消息流，生长为一张可回流的智能画布。</h1>
        <p className="summary">
          当前分支正在建立工程骨架。画布、语义锚点和 AI Proposal
          将在后续 Gate 中逐步接入，不在脚手架阶段提前耦合。
        </p>
      </section>

      <section className="foundation-grid" aria-label="Implementation foundations">
        {foundations.map((foundation, index) => (
          <article className="foundation-card" key={foundation}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <p>{foundation}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
