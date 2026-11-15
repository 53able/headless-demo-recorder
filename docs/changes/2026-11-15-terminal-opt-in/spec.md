# Terminal.app を明示した場合だけ desktop の入力先にする

## 背景
`scripts/appguard.ts` の拒否リストが Terminal.app（`com.apple.Terminal`）への入力を常に拒否していた。利用者から、ターミナルを録画対象にしたいという依頼があった。

拒否リストから外すだけでは、次の3つの問題が残る。

- シェルへの入力は、コマンドとして実行される。
- `check` の不可逆な操作の検証は対象の名前しか見ないので、打ち込む文字の中身は検査されない。
- エージェントを Terminal.app で動かしていると、エージェント自身のシェルに入力しうる。

## 事実（agent-desktop 1.3.0、openscreen で確認）
- `press` は物理キー入力で、`--app` / `--window-id` はプロセスを選ぶだけ。キーはそのプロセスのキーウィンドウに届く。Terminal.app は全ウィンドウを1プロセスで持つ。
- `snapshot` / `find` は `--window-id` でウィンドウに絞れる。`click` / `type` はそこで得た ref に対して行う。
- `openscreen record --window <t>` は、タイトルに t を含む最初のウィンドウを録る。これまで入力先は `source.window` を見ずに、アプリの最初の可視ウィンドウを選んでいた。
- session のサーバーは detached で起動する。`startDesktop` の間は起動元の CLI が待っているので、プロセスの祖先をたどれる。終わると launchd に付け替わる。

## 変更
1. `appguard.ts`
   - Terminal.app を拒否リストから外し、opt-in の対象にした（`OPT_IN_PREFIXES`、前方一致）。許可するのは `--allow-app` に完全一致で書かれたときだけ。
   - opt-in のアプリには、入力のたびに次の条件を課す（`optInRefusal`）。満たさなければ拒否する。
     - アプリのウィンドウが録画中の1つだけである。
     - この CLI がアプリの子孫として動いていない。判定は録画の開始前に1回行う。判定できないときも拒否する。session では、`session start` の CLI が自分の祖先の pid を config（`launcherAncestors`）で渡し、サーバーはそれで判定する。サーバーは launchd に付け替わりうるため。渡されなければ拒否する。
     - アプリの配下で tmux / screen / zellij / ssh などが動いていない。
2. `capture/desktop.ts`
   - `source.window` があれば、入力先をタイトルにそれを含むウィンドウから選ぶ。1つも無ければ、録画を始める前に失敗する。
   - opt-in のアプリでは、改行を含む `fill` を拒否する。
3. 文書: README、SKILL.md のガードレール、`errors.ts` のヒント、`types.ts` の `DesktopSource.window` のコメントを更新した。
4. `package.json` を 0.3.2 にした。

## 確認
- `bun test`: 80 件通過、3 件失敗。失敗した3件は HEAD でも失敗する。Bun 1.3.14 で Unix ソケットの半閉じが動かず、session のクライアントが応答を読めないため。
- `bun run typecheck`: 通過。
- 実録画: `assets/desktop-calculator.json` の `run` と `inspect --video` を行った。5コマすべてで、操作・マーカー・字幕が一致した。
- `edit.idleSpeedupMs` 付きの desktop session: 上の Bun の不具合で `SESSION_BAD_REPLY` になり、最後まで実行できなかった。録画の開始（`window` 指定のタイトル絞り込みを含む）と、サーバー側での act の実行は、ログで確認した。
- Terminal.app（実機で、録画を始める前に止まる経路だけを確かめた）
  - `--allow-app` なし → `APP_NOT_ALLOWED`
  - 計算機だけを許可 → `APP_NOT_ALLOWED`
  - 一致しない `window` → `no visible window`
- 実データでの読み取りのみの判定: ウィンドウ1つ、CLI は Terminal.app の外、tmux なし → 許可。

## 既知の制約
- 別の Space にある Terminal.app のウィンドウや、最小化したウィンドウが `list-windows` に出ない場合は、ウィンドウ数の条件で検出できない。
- 検査してから入力するまでの間に新しいウィンドウが開いた場合は防げない。次の入力の前の検査で止まる。
- `session act` を呼ぶクライアントが Terminal.app の中で動いているかは確かめない。確かめるのは、session を開始したときの CLI だけ。
- Terminal.app 以外のターミナル（iTerm2、Ghostty、WezTerm、kitty、Warp など）は opt-in の対象外で、従来どおり `--allow-app` なしでも入力できる。

- tmux などの検出はプロセス名（argv[0]）で行う。名前を変えた起動や、一覧に無いツールは防げない。これらの検査は誤って入力が届くのを防ぐもので、サンドボックスではない。
- 改行を含む `fill` は実行時にしか拒否しない。`check` の段階では、入力先のアプリが分からないため。
- Terminal.app では入力の前の検査（`lsappinfo`、`ps -A`、`list-windows`）が増えるので、マーカーの時刻が実際の入力より早くなりうる。

## 未決事項（人の判断が要る）
- iTerm2 などを opt-in の対象に加えるか。既定の挙動を変えるので、マイナー版を上げる。
- `session act` のクライアント側も検査するか。session.ts の通信の形を変える必要がある。
- 版の上げ幅。今回は 0.3.2 とした。`source.window` が一致しないときに失敗するようになった点を、修正（パッチ）と見るか、既定の挙動の変更（マイナー）と見るか。
- Bun 1.3.14 で session が動かない問題を、別の変更として直すか。
