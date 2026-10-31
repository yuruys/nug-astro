const cookiePrefix = 'nug_oauth_return_';
const localOrigin = 'https://oauth-return.invalid';

export function sanitizeReturnPath(value: string | null): string | null {
	if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
	try {
		const target = new URL(value, localOrigin);
		if (target.origin !== localOrigin || target.pathname.startsWith('/api/auth/')) return null;
		return `${target.pathname}${target.search}${target.hash}`;
	} catch {
		return null;
	}
}

export function createReturnToCookie(state: string, value: string | null): string | null {
	const safePath = sanitizeReturnPath(value);
	if (!safePath) return null;
	return `${cookiePrefix}${state}=${encodeURIComponent(safePath)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

export function getOAuthReturnTo(request: Request, state: string): string {
	const name = `${cookiePrefix}${state}=`;
	const cookie = request.headers.get('Cookie') ?? '';
	const value = cookie
		.split(';')
		.map((part) => part.trim())
		.find((part) => part.startsWith(name))
		?.slice(name.length);
	if (!value) return '/account/';
	try {
		return sanitizeReturnPath(decodeURIComponent(value)) ?? '/account/';
	} catch {
		return '/account/';
	}
}

export function clearReturnToCookie(state: string): string {
	return `${cookiePrefix}${state}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
