# Terminal.app を明示した場合だけ desktop の入力先にする

## 背景
`scripts/appguard.ts` の拒否リストが Terminal.app（`com.apple.Terminal`）への入力を常に拒否していた。利用者から、ターミナルを録画対象にしたいという依頼があった。

拒否リストから外すだけでは、次の3つの問題が残る。

- シェルへの入力は、コマンドとして実行される。
- `check` の不可逆な操作の検証は対象の名前しか見ないので、打ち込む文字の中身は検査されない。
- エージェントを Terminal.app で動かしていると、エージェント自身のシェルに入力しうる。

## 事実（agent-desktop 1.3.0、openscreen で確認）
- `press --app` は物理キー入力で、キーはそのプロセスのキーウィンドウに届く。キーウィンドウを読む手段は無い（`list-windows` の `is_focused` は OS 全体のフォーカスで、背面のアプリでは単一ウィンドウでも false。snapshot にも main の状態は出ない）。`press --window-id` は、そのウィンドウがアクティブだと確かめられなければ何も送らない（`exact_window_focus_unconfirmed`）ので、背面で録るヘッドレスの運用では使えない（いずれも実測）。Terminal.app は全ウィンドウを1プロセスで持つ。
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
     - アプリの端末（タブまたはウィンドウ）が1つだけ（`sessionsUnder`。アプリの直下の子プロセスの数）。キーは前面のタブに届くため。検証で、`list-windows` にも System Events にもウィンドウが1つと見える Terminal.app が、別のタブで別の Claude Code を動かしていた（ttys008）。ウィンドウ数だけの検査はこれを許可していた。
     - 録画を始める時点で、端末がシェルのプロンプトで待機している（`foregroundUnder`。前面のプロセスグループ（ps の stat の `+`）にシェル以外がいない）。タブが1つでも、そこで別のエージェントが動いていればキーがそちらに入るため。実測では、待機中のシェルは `S+`、コマンドを実行中のシェルは `S` で、コマンドが `S+`。最上位のプロセス（Terminal.app の子、または `login` の子）がシェルでなければ、`+` が無くても拒否する（`exec claude`、プロファイルの起動コマンド、「新規コマンド」）。録画を始めた後は、デモで起動したプログラムへの入力を許すため確かめない。
2. `capture/desktop.ts`
   - `source.window` があれば、入力先をタイトルにそれを含むウィンドウから選ぶ。1つも無ければ、録画を始める前に失敗する。
   - opt-in のアプリでは、改行を含む `fill` を拒否する。
   - `press` は、どのアプリでも、キーを受けうるウィンドウが録画中の1つだけのときに限って送る（`soleWindowRefusal`）。ほかにあれば `WINDOW_NOT_SOLE` で止める。アクセシビリティの要素を持たず、録画中のウィンドウの内側に収まる補助ウィンドウは数えない（`keyWindowCandidates`。条件は、見えている・`accessible: false`・録画中のウィンドウの現在の範囲の内側・面積がその 1/4 以下。計算機は操作中に 66×20 の「Window」を出す。実測）。opt-in のアプリ（Terminal.app）では除外せず、すべてのウィンドウを数える。`run` / `capture` は、シナリオに `press` があれば録画の開始前にもこの条件を確かめる。ウィンドウの一覧を読めなければ拒否する。
   - イベントの時刻は、検査を終えて入力する直前に記録する。検査の時間ぶん、マーカーや字幕が実際の入力より早まらないようにするため。
3. `session.ts`: クライアントは要求を `end(data)` ではなく `write` で送る。Bun 1.3.14 では、Unix ソケットに `end(data)` で送ると要求も応答も届かず（実測）、session の全コマンドが `SESSION_BAD_REPLY` になっていた。サーバーは改行で要求を区切って応答し、接続を閉じる。
4. 文書: README、SKILL.md のガードレール、`errors.ts` のヒント、`types.ts` の `DesktopSource.window` のコメントを更新した。
5. `package.json` を 0.4.0 にした。`press` の新しい制約で、ほかのウィンドウを持つアプリへの `press` が止まるようになり、既定の挙動が変わるため。

## 確認
- `bun test`: 90 件すべて通過（Terminal の前面の検査に `exec claude` などの用例を含む）（session の修正前は、main でも session/serve の3件が失敗していた）。
- `bun run typecheck`: 通過。
- 配布の形: 一時ディレクトリで `npx skills add <リポジトリ> --skill headless-demo-recorder -a claude-code -a codex -y` を実行し、導入先の `schema` が `ok:true` を返した。
- 実録画: `assets/desktop-calculator.json` の `run` と `inspect --video` を行った。5コマすべてで、操作・マーカー・字幕が一致した。
- `edit.idleSpeedupMs` 付きの desktop session（`window` を指定）: `start` → `observe` → `act` 7手（`press escape` 2回、click 4回、4秒の wait、`press return`）→ `stop` → `render` → `inspect --video` を通した。早送りの区間は2つ。7コマすべてで操作・マーカー・字幕が一致した。補助ウィンドウを数えないようにする前は、計算機への `press` が `WINDOW_NOT_SOLE` で止まった（これで補助ウィンドウに気づいた）。
- Terminal.app（実機で、録画を始める前に止まる経路だけを確かめた）
  - `--allow-app` なし → `APP_NOT_ALLOWED`
  - 計算機だけを許可 → `APP_NOT_ALLOWED`
  - 一致しない `window` → `no visible window`
- 実データでの読み取りのみの判定: ウィンドウ1つ、CLI は Terminal.app の外、tmux なし → 許可。

## 既知の制約
- 別の Space にある Terminal.app のウィンドウや、最小化したウィンドウが `list-windows` に出ない場合は、ウィンドウ数の条件で検出できない。ただし端末の数（直下の子プロセス）で数えるので、そうしたウィンドウやタブがあれば止まる。
- 録画の開始後に、人や別の自動化が録画中のタブで起動したプログラムは検出できない（前面の検査は開始時だけ）。
- ps の行を解析できなければ拒否する。
- 検査してから入力するまでの間に新しいウィンドウが開いた場合は防げない。次の入力の前の検査で止まる。
- `session act` を呼ぶクライアントが Terminal.app の中で動いているかは確かめない。確かめるのは、session を開始したときの CLI だけ。
- Terminal.app 以外のターミナル（iTerm2、Ghostty、WezTerm、kitty、Warp など）は opt-in の対象外で、従来どおり `--allow-app` なしでも入力できる。
- tmux などの検出はプロセス名（argv[0]）で行う。名前を変えた起動や、一覧に無いツールは防げない。これらの検査は誤って入力が届くのを防ぐもので、サンドボックスではない。
- 改行を含む `fill` は実行時にしか拒否しない。`check` の段階では、入力先のアプリが分からないため。
- Terminal.app に実際に入力する経路は、実機で試していない。開発機の Terminal.app には利用者の実シェルのウィンドウが1つあり、検査はそこへの入力を許すため。別インスタンスを起動する方法は、`press --app` が `AMBIGUOUS_TARGET` になるので使えない。

## 未決事項（人の判断が要る）
- iTerm2 などを opt-in の対象に加えるか。既定の挙動を変えるので、マイナー版を上げる。
- `session act` のクライアント側も検査するか。session.ts の通信の形を変える必要がある。
- `press` を、ほかのウィンドウを持つアプリで止めるようにした（0.4.0）。これまでは、アプリのキーウィンドウが録画中のウィンドウでなくてもキーを送っていた。止めずに警告だけにする選択肢もある。
- Terminal.app に実際に入力する経路の実機での確認。利用者の Terminal.app のウィンドウを閉じた状態か、利用者の許可を得てそのシェルに無害なコマンド（`echo`）を打つ形で行う。
