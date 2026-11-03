# 録画中に画面を見ながら進める（session）

手順を事前に決め切れない場合は `session` を使う。例えば、画面の内容によって次の操作が変わる場合や、想定外のダイアログに対応する場合がこれに当たる。録画を開いたまま、観察と1手の操作を繰り返す。

1. SKILL.md の作業ループ1〜3と同じく、`doctor` を確かめてシナリオを書く。`steps` は空でよい。録画開始直後に必ず行う操作（初期化など）だけを `steps` に入れる。`check` を通す。
2. `session start <scenario> [--allow-origin …] [--allow-app …]` を実行する。`ok:true` と `status: "recording"` が返ったら録画中になっている。
3. 次の a〜c を繰り返す。
   a. `session observe <project-dir>` で画面を見る。
      - ブラウザでは `snapshot.refs` のキー `eN` に `@` を付けた `@eN`（`eN`、`ref=eN` も同じ扱い）が、デスクトップでは `snapshot.tree` の `ref_id`（`@<snapshot_id>:eN`）がそのまま、`act` の `target` に使える。
      - 使えるのは、このセッションの**直近の** `observe` が返した参照だけ。1手実行するたびに参照は無効になるので、参照で指す手の前には毎回 `observe` する。別のアプリの参照、古い参照は `INVALID_STEP` で拒否される。
      - 参照が指す要素の名前（例: `button Delete account`）は、観察した時点のものが不可逆な操作の検証にかかる。セレクタや find クエリで指した場合に検証されるのは、書いた文字列だけ（要素の実際の名前は見ない）。名前で確かめたい操作は、観察した参照で指す。
      - 見た目で判断する必要があるときは `--screenshot` を付け、返る `screenshot` の PNG を開く。
   b. 次の1手を決めて、`session act <project-dir> '<step JSON>'` を実行する。字幕には、その手を打つ理由を書く。
   c. 返答を読む。
      - `ok:true`: 次の観察へ進む。
      - `INVALID_STEP`: 何も実行されていない。手を直す。
      - `RECORDER_DIED`（`retry: no`）: 録画が勝手に終わった（ウィンドウが閉じた、クラッシュなど）。それまでの録画は保存処理に回る。`session status` で結果を確かめ、アプリの状態を見てから `session start --force` で始め直す。
      - それ以外の `ok:false`（`TARGET_NOT_FOUND` など）: 録画は続いており、失敗した手はログから外れている。もう一度 `observe` してから次の手を選ぶ。再録画しない。
4. 終わったら必ず `session stop <project-dir>` を実行する。録画中のプロセスを残さない。
5. 返る `next` に従って `render <project-dir> --scenario <scenario> --force` を実行し、SKILL.md の作業ループ5〜6（`inspect` と目視確認）を行う。

- 考えている時間もそのまま録画に入る。`edit.idleSpeedupMs`（例: 1500）で、操作のない区間を早送りする。
- 手は1つずつ順に実行される。セッション内の `wait` の `ms` と各手の `waitMs` の上限は `scripts/types.ts` の `Step` の型コメントに従う。`session status` は手の実行中でも答える（`busy: true`）。
- 最後の要求が終わってから `--idle-timeout` 秒（既定 600）が経つと、録画は自動で停止・保存される。手の実行中には止まらない。
- `session status` が `failed` を返したら、返る `log`（サーバのログ）を読む。開始に失敗した場合（`SESSION_START_FAILED`、`retry: no`）は、アプリやブラウザの状態を確かめてから `session start --force` で始め直す。
- 1つの project を録画できるのは1本だけ。録画中は、同じ project への `session start` / `capture` / `run` が `SESSION_ACTIVE` で止まる。

## 複数のエージェントで同時に録る

1. エージェントごとに別のシナリオ（別の `name` と `output.path`）を用意する。そのうえで、すべてのセッションを同じ `--group <名前>` で続けて開始する。
2. 各エージェント（サブエージェントなど）は、自分の project だけに対して `observe` / `act` を繰り返す。互いの手を待ち合わせる仕組みはない。
3. 全員が終わったら、各 project を `session stop` する。
4. それらのシナリオを参照する composition を書き、`render <compProj> --composition <c.json> --force` で結合する。続けて `inspect` する。
   - 同じ group のセッションは開始時刻が揃えられる。後に始まった録画の開始時点が、結合後の先頭になる。
   - 揃えるのは、開始時刻の差が10分以内の場合だけ。同じ group 名を別の日に使い回した録画は揃えない。録り直すときは、全員分を同時に始め直す。
5. 同じアプリを2つのセッションで操作しない。desktop の入力は同じウィンドウに届くため。
