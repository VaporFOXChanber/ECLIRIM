/** The host-permission pattern for a page's own site. Only web pages can be lit, so anything else has none. */
export function sitePattern(url = ''): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    return /^https?:$/.test(protocol) && hostname ? `${protocol}//${hostname}/*` : null;
  } catch { return null; }
}
/** The name a page's site profile is stored under: its host name, or `file` for local files. Pages that cannot be lit have none. */
export function siteKey(url = ''): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === 'file:') return 'file';
    return /^https?:$/.test(protocol) && /^[a-z0-9.-]{1,253}$/.test(hostname) ? hostname : null;
  } catch { return null; }
}
