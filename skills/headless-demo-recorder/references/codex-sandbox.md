# Codex のサンドボックス

Codex のサンドボックス（`workspace-write`）では、次のコマンドを**最初から**サンドボックス外で実行する許可を求める。サンドボックス内で試さない。

- `doctor`、`render`、`run`: `openscreen` CLI の実体は Electron アプリで、サンドボックス内で起動するとウィンドウサーバーへの登録を拒否されてクラッシュする（実測）。そのたびに macOS のクラッシュレポートが作られ、利用者の画面にダイアログが出る。
  - サンドボックス内の `doctor` は、`openscreen CLI` に加えて `permissions` の項目も `Operation not permitted` で失敗する。権限の未付与ではない。
  - サンドボックス内の `render` は、空のメッセージの `PROJECT_INVALID` を返す。`hint`（capture.mp4 の配置）に従って再試行しない。
- browser / desktop の `capture` と、下見の `agent-browser` / `agent-desktop`: ブラウザやアプリの起動とネットワーク接続を伴う。file ソースの `capture` はサンドボックス内で動くが、続く書き出しに `openscreen` が要るので、`run` はサンドボックス外で実行する。
- `session` の各サブコマンド: `start` はブラウザ・アプリ・録画を起動する。`observe` / `act` / `status` / `stop` は一時ディレクトリの Unix ソケットで録画中のプロセスと通信するが、サンドボックス内からはこのソケットに接続できない（`SESSION_UNREACHABLE`、ECONNREFUSED。実測）。すべてサンドボックス外で実行する。
- `check`、`plan`、`inspect`、`schema` はサンドボックス内で動く（実測）。
