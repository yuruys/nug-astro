type DiscordUser = { id?: string; username?: string; global_name?: string | null; avatar?: string | null };
const textError = (message: string, status = 400) => new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
export const onRequestGet: PagesFunction<{ DB: D1Database; DISCORD_CLIENT_ID: string; DISCORD_CLIENT_SECRET: string }> = async ({ request, env }) => {
 const url = new URL(request.url); const code = url.searchParams.get('code'); const state = url.searchParams.get('state');
 if (url.searchParams.has('error')) return textError('Discordログインがキャンセルされました。サイトに戻ってもう一度お試しください。');
 if (!code || !state || !/^[0-9a-f-]{36}$/i.test(state)) return textError('Discordから必要な認証情報を受け取れませんでした。もう一度ログインしてください。');
 if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return textError('Discordログインの設定が不足しています。サイト管理者にお問い合わせください。', 503);
 const stateCookieName = `nug_discord_oauth_state_${state}`;
 const stateCookiePattern = new RegExp(`(?:^|;\\s*)${stateCookieName}=([^;]+)`);
 const stateMatch = (request.headers.get('Cookie') ?? '').match(stateCookiePattern);
 if (!stateMatch || stateMatch[1] !== state) return textError('ログインの確認情報が一致しません。Cookieを有効にして、もう一度お試しください。');
 const redirectUri = `${url.origin}/api/auth/discord/callback`;
 try {
  const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirectUri }) });
  if (!tokenResponse.ok) return textError('Discordとの接続に失敗しました。設定とリダイレクトURLを確認して、もう一度お試しください。', 502);
  const token = await tokenResponse.json() as { access_token?: string; token_type?: string };
  if (!token.access_token) return textError('Discordからアクセストークンを取得できませんでした。もう一度お試しください。', 502);
  const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `${token.token_type ?? 'Bearer'} ${token.access_token}` } });
  if (!userResponse.ok) return textError('Discordのユーザー情報を取得できませんでした。もう一度お試しください。', 502);
  const discordUser = await userResponse.json() as DiscordUser;
  if (!discordUser.id) return textError('DiscordからユーザーIDを取得できませんでした。', 502);
  const existing = await env.DB.prepare(`SELECT users.id FROM user_identities INNER JOIN users ON users.id = user_identities.user_id WHERE user_identities.provider = ? AND user_identities.provider_user_id = ? LIMIT 1`).bind('discord', discordUser.id).first<{ id: string }>();
  let userId: string; const displayName = discordUser.global_name || discordUser.username || 'Discordユーザー';
  const avatarUrl = discordUser.avatar ? `https://cdn.discordapp.com/avatars/${encodeURIComponent(discordUser.id)}/${encodeURIComponent(discordUser.avatar)}.png?size=256` : null;
  if (existing) { userId = existing.id; await env.DB.prepare(`UPDATE users SET display_name = ?, avatar_url = ?, updated_at = datetime('now') WHERE id = ?`).bind(displayName, avatarUrl, userId).run(); }
  else { userId = crypto.randomUUID(); await env.DB.batch([env.DB.prepare(`INSERT INTO users (id, display_name, avatar_url, role, created_at, updated_at) VALUES (?, ?, ?, 'user', datetime('now'), datetime('now'))`).bind(userId, displayName, avatarUrl), env.DB.prepare(`INSERT INTO user_identities (id, user_id, provider, provider_user_id, created_at) VALUES (?, ?, 'discord', ?, datetime('now'))`).bind(crypto.randomUUID(), userId, discordUser.id)]); }
  const sessionId = crypto.randomUUID(); const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, datetime('now'))`).bind(sessionId, userId, expiresAt).run();
  const headers = new Headers({ Location: '/account/', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', `nug_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`); headers.append('Set-Cookie', `${stateCookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return new Response(null, { status: 302, headers });
 } catch { return textError('Discordログインの処理中にエラーが発生しました。時間をおいて、もう一度お試しください。', 502); }
};
