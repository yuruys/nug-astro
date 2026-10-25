# ゆるぽーと (yuruport)

公開サイト: https://yuruport.com/

Minecraftマルチサーバーの攻略・仕様・最新情報をまとめた非公式ガイドです。ガイド、ニュース、ツール、Wikiを提供します。

## 技術スタック

- Astro 7 と Astro Content Collections
- Starlight によるWiki
- Pagefind によるサイト内検索
- Cloudflare Pages Functions と D1
- TypeScript、Markdown、MDX

## 開発環境

- Node.js 22.12 以上
- npm

```sh
npm install
npm run dev
```

`npm run dev` は起動前に `prepare:pagefind` を実行し、AstroのビルドとPagefind生成を行います。`public/pagefind/` は追跡されている生成ファイルのため、検索インデックスが更新される場合があります。

## コマンド

- `npm run dev`: Pagefindを準備して開発サーバーを起動
- `npm run build:astro`: Astroサイトを `dist/` にビルド
- `npm run build`: Astroをビルドし、`dist/` にPagefindインデックスを生成
- `npm run prepare:pagefind`: ビルドと検索インデックス生成後、インデックスを `public/pagefind/` にコピー
- `npm run preview`: 直近のAstroビルドをローカルでプレビュー
- `npm run astro -- check`: Astro、TypeScript、コンテンツの診断

## 主要ディレクトリ

- `src/pages/`: URLに対応するAstroページ。公開URLを維持してください。
- `src/components/layout/`: 共通ナビゲーション、サイト枠、Wiki編集用ヘッダー
- `src/components/cards/`: 記事・カテゴリーカード
- `src/components/search/`: 検索UI
- `src/components/admin/`: 管理画面で再利用するUI
- `src/content/docs/`: Starlight Wiki。既存の階層とfrontmatterを維持
- `src/content/guide/`, `src/content/news/`, `src/content/tool/`: 各コンテンツコレクション
- `src/layouts/`, `src/lib/`, `src/plugins/`, `src/styles/`: 共通レイアウト、ロジック、Markdownプラグイン、スタイル
- `functions/`: Cloudflare Pages Functions API
- `database/`, `migrations/`: D1スキーマとマイグレーション履歴
- `scripts/`: Pagefind準備とWikiデータの同期・初期化処理
- `public/`: 公開静的ファイル。画像などの既存パスを維持

## コンテンツの追加

ガイドは `src/content/guide/`、ニュースは `src/content/news/`、ツール情報は `src/content/tool/` に追加します。Wikiの記事は `src/content/docs/` 配下の既存分類に追加します。コレクションのスキーマは `src/content.config.ts` に定義されています。ツール画面はコンテンツデータとは別に `src/pages/tool/` で管理します。

## Cloudflare Pages

Astroのビルド出力は `dist/` です。Pages Functions はルートの `functions/` から検出され、D1のバインディングは `wrangler.jsonc` で設定されています。D1の再作成、マイグレーション実行、本番データへの書き込み、バインディングや `remote` 設定の変更は、別途承認なしに行わないでください。Wiki同期・初期化スクリプトも実行前に接続先と生成内容を確認してください。
Cloudflareのローカル開発環境でのpreviewコマンドは、`npx wrangler pages dev dist`

## Discord記事通知

`main` へのpushで、記事本文の追加・更新を専用Discord BOTから通知します。対象は次のコンテンツコレクションです。

| 領域 | 保存場所 | 公開URL |
| --- | --- | --- |
| 攻略ガイド | `src/content/guide/<id>.md` | `https://yuruport.com/guide/<id>/` |
| Wiki | `src/content/docs/docs/<path>.md` または `.mdx` | `https://yuruport.com/<path>/` |
| ニュース | `src/content/news/<id>.md` | `https://yuruport.com/news/<id>/` |
| ツール | `src/content/tool/<id>.md` | `https://yuruport.com/tool/<id>/` |

記事の削除、各コレクション直下の `index.md`、画像・CSS・設定ファイルなどは通知しません。複数コミットを1回のpushで送った場合、同じ記事は最終状態で1回だけ判定されます。一方、別々のpushやActionsの再実行では重複通知されることがあります。通知済み記事を記録する外部ストレージは使用していません。

通知はpushを契機に実行され、Cloudflare Pagesのデプロイ完了を待ちません。そのため、通知直後は公開URLへの反映前の可能性があります。Pagesのデプロイ方式はリポジトリ内の設定では確認できず、このワークフローは既存のデプロイ設定を変更しません。

### GitHub側の設定

リポジトリの **Settings → Secrets and variables → Actions** に、次のRepository secretsを登録してください。

- `DISCORD_BOT_TOKEN`: 専用BOTアカウントのBot token
- `DISCORD_CHANNEL_ID`: 通知先チャンネルのID（Discordの開発者モードでチャンネルIDをコピー）

BOTを対象サーバーに追加し、通知先チャンネルでメッセージを送信できる権限を付与してください。トークンはソースやActionsログに出力しません。設定漏れがある場合は不足しているSecret名をエラーに表示します。

通知処理のローカルテストは `node --test scripts/notify-discord.test.mjs` で実行できます。Discord secretsやAPIアクセスは不要です。

## Githubへのプッシュコマンド

git add .
git commit -m "軽微な修正"
git push origin main

# Githubの変更をオフラインに取り込む

git pull