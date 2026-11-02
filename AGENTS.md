# headless-demo-recorder: 開発者向けメモ

- 運用ガイドの正本は `skills/headless-demo-recorder/SKILL.md`。このリポジトリ内で録画を試すときも SKILL.md の手順に従う。
- CLI の実体は `skills/headless-demo-recorder/scripts/cli.ts`。リポジトリルートで `bun skills/headless-demo-recorder/scripts/cli.ts <command>` と呼ぶ。
- 型定義は `skills/headless-demo-recorder/scripts/types.ts`、example は `skills/headless-demo-recorder/assets/`（リポジトリルートを cwd にした形で書く）。
- テストは `bun test`、型検査は `bun run typecheck`。
