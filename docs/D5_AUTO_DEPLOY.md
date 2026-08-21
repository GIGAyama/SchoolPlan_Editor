# D5: GASへの反映を自動にする

## これで何が変わるか

これまでは、変更のたびに Apps Script エディタへファイルを手でコピーしていました。対象は **53ファイル**（`.gs` 23個・`.html` 29個・`appsscript.json`）で、1つ貼り忘れると起動時に「〇〇 is not defined」とだけ出ます。

設定を済ませると、`main` にマージした時点で次が自動で走ります。

1. 品質ゲート（`npm run check` と `npm test`）
2. **いまGASにある中身の控えを取る**（あとで取り出せるよう成果物として30日残す）
3. リポジトリの内容をGASプロジェクトへ反映
4. **既存のデプロイ**を新しいバージョンへ差し替え（**URLは変わりません**）

品質ゲートが落ちたら、GASには一切触れません。

## 1度だけの準備

### 手順1: Apps Script API をオンにする

<https://script.google.com/home/usersettings> を開き、「Google Apps Script API」をオンにします。これがオフだと、ツールからの反映がすべて拒否されます。

### 手順2: 手元でログインする

```bash
npm ci
npm run gas:install   # clasp を入れる（リポジトリの依存には含めていません）
npm run gas:login     # ブラウザが開くので、GASプロジェクトの持ち主のアカウントで許可する
```

ログインすると `~/.clasprc.json`（Windows は `%USERPROFILE%\.clasprc.json`）ができます。**この中身が鍵そのものです。** 人に見せたり、リポジトリに置いたりしないでください。

### 手順3: 3つの値を GitHub に登録する

リポジトリの **Settings → Secrets and variables → Actions → New repository secret** で登録します。

| 名前 | 何を入れるか | どこで分かるか |
|---|---|---|
| `GAS_SCRIPT_ID` | スクリプトID | Apps Script エディタのURL `.../projects/**ここ**/edit` |
| `GAS_DEPLOYMENT_ID` | デプロイID | Apps Script →「デプロイを管理」→ 対象のデプロイ →「デプロイID」 |
| `CLASPRC_JSON` | `~/.clasprc.json` の**中身をまるごと** | 手順2で作られたファイル |

`GAS_DEPLOYMENT_ID` は、**いま先生方が使っているURLのデプロイ**を指定してください。ここを間違えると、更新しても使われていないほうのデプロイが新しくなるだけで、URLの中身は古いままになります。

### 手順4: 手元で確かめる

```bash
GAS_SCRIPT_ID=<スクリプトID> npm run gas:status
```

送られるファイルの一覧が出ます。`Tracked files` に53個並び、`docs/` や `tests/` や `node_modules/` が `Untracked files` 側にあれば正しい状態です。

## 毎回の流れ

**何もしません。** `main` にマージすると GitHub Actions の `Deploy to Apps Script` が走ります。Actions タブで結果を確認できます。

反映のあとは、ブラウザ／PWAを完全に再読み込みしてください（画面側のHTMLはキャッシュに残ります）。

### 手元から一発で反映したいとき

```bash
GAS_SCRIPT_ID=<スクリプトID> GAS_DEPLOYMENT_ID=<デプロイID> npm run deploy
```

品質ゲート → 控え → 反映 → デプロイ更新を、まとめて行います。

## 気をつけること

### GASエディタで直接編集しない

`clasp push` は **GAS側を丸ごと上書き**します。エディタで直した箇所は、次の反映で消えます。直したいことがあれば、リポジトリ側を直してください。

とはいえ、うっかりは起きます。そのため**送る前に必ず控えを取ります**。

- 手元: `dist/gas-before-push/` に残ります
- GitHub Actions: 実行結果のページから `gas-before-push-<コミットID>` としてダウンロードできます（30日保持）

控えは「送る直前のGASの中身」そのものです。消えて困るものがあれば、ここから拾えます。

### マニフェストが「ウェブアプリであること」を持っている

Apps Script は、そのデプロイがウェブアプリなのかライブラリなのかを **`appsscript.json` で** 決めます。

```json
"webapp": {
  "executeAs": "USER_ACCESSING",
  "access": "ANYONE"
}
```

エディタから手でデプロイしていたころは、エディタがこれを書いてくれていました。`clasp push` は**GAS側のマニフェストを丸ごと上書き**するため、リポジトリ側に `webapp` が無いと、**新しいバージョンからウェブアプリの入り口が消えます**（デプロイの設定にライブラリのURLしか出なくなります）。自動反映を入れた最初の1回で、実際にそうなりました。

- `executeAs` は必ず `USER_ACCESSING`。`USER_DEPLOYING`（自分＝オーナーとして実行）にすると、全員がオーナーの権限で動き、`UserProperties` もオーナーのものになります。**全員が同じ1つのデータベースを共有**し、他学級の児童に関する記述が相互に見えます（`docs/LEGAL_RISK_AUDIT_JP.md` の C-2）。
- `access` は `ANYONE`（Googleアカウントを持つ全員）か `DOMAIN`（同一ドメイン）。`ANYONE_ANONYMOUS` はログイン不要になるため使えません。このアプリは `Session.getActiveUser()` で利用者を見分け、その人のDriveのデータを扱います。

`tests/gas-deploy.test.mjs` が、この3点をそれぞれ見張っています。

### URLは変わりません

自動反映は**既存のデプロイを差し替える**方式（`clasp deploy --deploymentId`）です。新しいデプロイを作ると別のURLになり、先生方のブックマークとPWAは古いURLを指したままになります。それを避けるために、デプロイIDを必ず指定しています。

### 秘密の扱い

- `.clasp.json` と `.clasprc.json` は `.gitignore` に入っています。`.clasp.json` は実行のたびに `GAS_SCRIPT_ID` から作り直されます。
- 控え（`dist/gas-before-push/`）には設定ファイルを混ぜません。成果物としてダウンロードしても、スクリプトIDは出ていきません。
- `CLASPRC_JSON` を入れ替えたいとき（パスワード変更・端末の紛失など）は、手順2をやり直して Secret を上書きしてください。

## うまくいかないとき

| 出るもの | 意味 | どうするか |
|---|---|---|
| `User has not enabled the Apps Script API` | 手順1をしていない | <https://script.google.com/home/usersettings> でオンにする |
| `Requested entity was not found` | `GAS_SCRIPT_ID` が違う、またはそのアカウントに権限が無い | エディタのURLを見直す。ログインしたアカウントが持ち主か確かめる |
| `Deployment not found` | `GAS_DEPLOYMENT_ID` が違う | 「デプロイを管理」でIDを取り直す |
| `invalid_grant` | 認証が切れた | 手順2をやり直し、`CLASPRC_JSON` を登録し直す |
| 自動反映が走らない | Secret がまだ無い | Actions のログに「まだ設定されていません」と出ます。手順3をする |
| 反映されたのに画面が古い | ブラウザ／PWAのキャッシュ | 完全に再読み込みする |
| デプロイの設定にライブラリのURLしか出ない | `appsscript.json` に `webapp` が無い | 上の「マニフェストが『ウェブアプリであること』を持っている」を参照 |
| 反映しても、先生の見る画面が変わらない | `GAS_DEPLOYMENT_ID` が別のデプロイを指している | 「デプロイを管理」で、`/exec` のURLが実際に配っているものと同じデプロイのIDか確かめる |

## この仕組みを見張っているもの

`tests/gas-deploy.test.mjs` が、次を固定しています。壊すとCIが落ちます。

- 品質ゲートを通してから、はじめてGASを触る
- 反映の前に、いまのGASの中身を控える
- 既存のデプロイを差し替える（新しく作らない＝URLを変えない）
- 控えにスクリプトIDを混ぜない
- 送るのはリポジトリ直下の `.gs` / `.html` / `appsscript.json` だけ
- 反映は直列にする（同時に走らせて古いコードで上書きしない）
- マニフェストがウェブアプリとしての入り口を宣言している（`executeAs` はアクセスしているユーザー、ログイン必須）
