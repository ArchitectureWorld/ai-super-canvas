'use client';

import styles from './control-plane-test.module.css';

export function ControlPlaneTestClient() {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.hero}>
          <p className={styles.kicker}>CONTROL PLANE · LOCAL ALPHA</p>
          <div className={styles.heroRow}>
            <div className={styles.heroCopy}>
              <h1 className={styles.title}>真实后端闭环</h1>
              <p className={styles.lead}>
                这里的测试 Session、消息和运行记录都会写入 PostgreSQL，不会沿用旧画布的浏览器演示数据。
              </p>
            </div>
            <button className={styles.primaryButton} type="button" disabled>
              新建测试 Session
            </button>
          </div>
        </header>

        <div className={styles.bodyGrid}>
          <section className={styles.conversationColumn} aria-labelledby="transcript-title">
            <div className={styles.panel}>
              <div className={styles.panelHeading}>
                <div>
                  <p className={styles.eyebrow}>SESSION TRANSCRIPT</p>
                  <h2 className={styles.sectionTitle} id="transcript-title">
                    PostgreSQL 会话记录
                  </h2>
                </div>
                <span className={`${styles.stateBadge} ${styles.warning}`}>等待 Session</span>
              </div>
              <div className={styles.emptyState}>
                <p className={styles.emptyTitle}>还没有持久化消息</p>
                <p className={styles.emptyCopy}>
                  后端连接完成后，新建一个测试 Session，再发送第一条消息。
                </p>
              </div>
            </div>

            <form
              className={styles.composer}
              onSubmit={(event) => {
                event.preventDefault();
              }}
            >
              <label className={styles.label} htmlFor="control-plane-test-message">
                测试消息
              </label>
              <textarea
                className={styles.textarea}
                id="control-plane-test-message"
                name="message"
                placeholder="先新建测试 Session，再输入要交给真实后端的内容"
                rows={4}
                disabled
              />
              <div className={styles.composerFooter}>
                <p className={styles.composerHint}>消息内容不会写入 localStorage。</p>
                <button className={styles.primaryButton} type="submit" disabled>
                  发送到真实后端
                </button>
              </div>
            </form>
          </section>

          <aside className={styles.sideColumn}>
            <section className={styles.panel} aria-labelledby="backend-status-title">
              <div className={styles.panelHeading}>
                <div>
                  <p className={styles.eyebrow}>BACKEND STATUS</p>
                  <h2 className={styles.sectionTitle} id="backend-status-title">
                    正在连接真实后端
                  </h2>
                </div>
                <span className={styles.pulse} aria-hidden="true" />
              </div>
              <dl className={styles.statusList}>
                <div className={styles.statusRow}>
                  <dt className={styles.statusName}>PostgreSQL</dt>
                  <dd className={styles.statusValue}>等待握手</dd>
                </div>
                <div className={styles.statusRow}>
                  <dt className={styles.statusName}>DeterministicFakeRuntime</dt>
                  <dd className={styles.statusValue}>等待握手</dd>
                </div>
              </dl>
            </section>

            <section className={styles.panel} aria-labelledby="run-events-title">
              <div className={styles.panelHeading}>
                <div>
                  <p className={styles.eyebrow}>RUN EVENT LOG</p>
                  <h2 className={styles.sectionTitle} id="run-events-title">
                    已持久化 Run 事件
                  </h2>
                </div>
              </div>
              <p className={styles.eventPlaceholder}>启动 Run 后，这里会显示从数据库读取的事件。</p>
            </section>

            <section className={`${styles.notice} ${styles.success}`} aria-label="数据边界">
              <p className={styles.noticeTitle}>页面与旧画布完全隔离</p>
              <p className={styles.noticeCopy}>
                浏览器只保留恢复操作需要的标识，不缓存对话正文或运行输出。
              </p>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}
