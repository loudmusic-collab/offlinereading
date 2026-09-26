import { readFileSync } from 'node:fs';

export const ORIGIN = 'https://news.example';

export function fixture(name, origin = ORIGIN, now = Date.now()) {
  const hour = 3600 * 1000;
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .replaceAll('{{ORIGIN}}', origin)
    .replace(/\{\{DATE(\d)\}\}/g, (_, n) => new Date(now - Number(n) * hour).toUTCString());
}
