# Score Viewer

ピアノ演奏用の PDF 楽譜ビューア（PWA）。Android 7.1.1 の Chrome 119 で動くことを下限に設計。

- 配信先: https://nakamura-zcyg.github.io/score-viewer/
- リポジトリ: https://github.com/Nakamura-zcyg/score-viewer

## 操作

| 操作 | 動作 |
|---|---|
| ページモード: 画面右半分をタップ | 次のページ |
| ページモード: 画面左半分をタップ | 前のページ |
| 半ページモード: 画面下半分をタップ | 次（同ページの下半分、または次ページの上半分） |
| 半ページモード: 画面上半分をタップ | 前 |
| 横幅いっぱいモード | ページ幅を画面幅に合わせる。縦にはみ出す場合は上下タップ、収まる場合は左右タップ |
| 長押し (500ms) | メニュー（ページ選択・繰りモード・全画面・ライブラリへ戻る） |
| Bluetooth ペダル／キーボード | PageDown・→・↓・Space・Enter で次、PageUp・←・↑・Backspace で前 |
| Android の戻るボタン | ライブラリへ戻る |
| ライブラリの「名前」 | 表示名を変更（ファイル名とは独立） |

タップは指を離した時点で判定する（押下 400ms 未満・移動 12px 未満）。長押し中はページが動かない。

繰りモードはメニューで「自動／ページ全体／半ページ／横幅いっぱい」を選べる。自動は横向きなら半ページ、縦向きならページ全体。タップの向きは表示が縦に分割されているかで決まる。分割ありなら上下、なしなら左右。

半ページモードでは、上下それぞれがページ高さの 57.5% を表示する（15% の重なり）。ちょうど半分で割ると段が上下に分断されるため。比率は `Viewer.tsx` の `HALF_VIEW_FRACTION` で変えられる。画面が極端に横長で 2 分割に収まらない場合は自動で 3 分割以上になる。レイアウトは 1 ページ目の寸法で決めるので、ページごとに寸法が違う PDF ではずれる。

## Google Drive 同期

ライブラリの「Drive と同期」を押すと、Google アカウントでサインインし、Drive の「Score Viewer」フォルダと突き合わせる。

- ここにあって Drive にない PDF → アップロード
- Drive にあってここにない PDF → ダウンロード
- アプリで変えた名前 → Drive に反映。それ以外は Drive 側の名前を正とする
- 削除 → Drive 側のファイルも削除（ローカルだけ消すと次の同期で戻ってくるため）

想定する使い方は「PC のブラウザで PDF を追加して同期、タブレットで同期して演奏」。同期はボタンを押した時だけ動くので、演奏中にサインイン画面が出ることはない。

スコープは `drive.file`（このアプリが作ったファイルだけ触れる、審査不要）。そのため Drive の画面から直接フォルダに入れた PDF はアプリから見えない。追加は必ずアプリの「PDF を追加」経由で行う。

OAuth クライアント ID は `.env` の `VITE_GOOGLE_CLIENT_ID`。Google Cloud Console で「ウェブ アプリケーション」として作り、承認済み JavaScript 生成元に配信先と `http://localhost:5173` を登録する。API キーは不要。

タブレットのホーム画面から起動した PWA でサインインのポップアップが戻ってこない場合は、タブレットの Chrome で同じ URL を開いて同期する。保存先は PWA と共通。

## 構成

- Vite + React + TypeScript
- PDF 描画: `pdfjs-dist` の legacy build（古い Chrome 向け）。前後 2 ページを先読みしてオフスクリーン canvas に保持
- 保存: IndexedDB に PDF 本体と最後に開いたページを保存。オフラインで動く
- PWA: `vite-plugin-pwa`。ホーム画面に追加すると全画面で起動

## 開発

```bash
npm install
npm run dev      # http://localhost:5173（--host 付きなので LAN 内の実機からも開ける）
npm run build    # tsc + vite build → dist/
```

## 配信 (GitHub Pages)

1. GitHub にリポジトリを作り、`main` に push する
2. リポジトリの Settings → Pages → Source を **GitHub Actions** にする
3. push のたびに `.github/workflows/deploy.yml` がビルドして `https://<user>.github.io/<repo>/` に配信する

ベースパスはワークフロー内で `BASE_PATH=/<repo>/` として渡している。独自ドメインやルート配信にする場合は `BASE_PATH=/` にする。

Service Worker と Wake Lock は HTTPS でしか動かない。`npm run dev` を LAN で開く場合はこれらが無効になるが、ページ繰り自体は動く。

## 実機で使う

1. Android の Chrome で配信 URL を開く
2. メニュー →「ホーム画面に追加」
3. ホーム画面のアイコンから起動すると、ブラウザ UI なしの全画面で開く
4. 「PDF を追加」で端末内の PDF を取り込む（取り込んだ後はオフラインで開ける）
