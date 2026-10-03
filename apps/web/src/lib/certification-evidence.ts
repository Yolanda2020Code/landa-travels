const DAY_MS = 24 * 60 * 60 * 1000;

export function isCertificationEvidenceFresh(validUntil: string, checkedAt: string, now = Date.now()): boolean {
  const expiry = /^\d{4}-\d{2}-\d{2}$/.test(validUntil)
    ? Date.parse(`${validUntil}T23:59:59.999Z`)
    : Date.parse(validUntil);
  const checked = Date.parse(checkedAt);
  return Number.isFinite(expiry) &&
    expiry >= now &&
    Number.isFinite(checked) &&
    checked <= now &&
    checked >= now - DAY_MS;
}