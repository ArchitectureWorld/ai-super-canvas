# Gate 0 风险优先交互纵切实施计划

> 用户已明确授权立即开发和部署。本计划只实现 `2026-07-15-risk-first-interactive-slice.md` 的范围，不把演示状态称为完整 Alpha。

## 任务 1：领域契约与单元测试

- [ ] 先添加 `packages/core/src/workspace.test.ts`，覆盖 Unicode code point 锚点、非法引文、结论卡回写新修订、命令去重和分支生命周期。
- [ ] 确认测试在实现前失败。
- [ ] 创建 `ids.ts`、`text-position.ts`、`workspace.ts`、`index.ts`，实现纯函数命令和不可变状态。
- [ ] 运行 core 测试、类型检查与 lint。

## 任务 2：浏览器工作台

- [ ] 先添加页面可访问性/状态转换测试，确认缺少交互组件时失败。
- [ ] 新增客户端 `WorkspacePrototype`：主干编辑、选区锚点、分支消息、演示 AI、结论卡、显式回写、生命周期控制和时间线。
- [ ] 使用 `localStorage` 保存和恢复工作区；无可用数据时加载可理解的示例。
- [ ] 保持页面层为 Server Component，将浏览器状态放在最小 Client Component。
- [ ] 更新页面、样式和健康端点阶段标识。

## 任务 3：端到端与部署

- [ ] 添加 Playwright Golden Path：选择文本、创建分支、生成并回写结论、刷新后确认新修订存在。
- [ ] 修正 Playwright 用例目录与生产端口配置。
- [ ] 执行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `pnpm test:e2e`。
- [ ] 以 Docker Compose + `systemd --user` 在 `127.0.0.1:3000` 运行；不对 LAN 暴露。
- [ ] 更新 `/home/youran/data/service-ports.md` 和 `service-ports.json`，再用 HTTP、容器健康状态与浏览器三重验证。

## 审查点

完成任务 1 后检查领域术语是否把讨论记录和主干修订混淆；完成任务 2 后检查“回写”是否仅由显式操作触发；完成任务 3 后确认服务重启后仍可访问。
