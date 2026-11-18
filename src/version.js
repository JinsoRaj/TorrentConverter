import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const APP_NAME = 'TorrentConverter';
export const APP_VERSION = pkg.version;
export const REPO_URL = 'https://github.com/JinsoRaj/TorrentConverter';
