import { join } from 'node:path';
import { homedir } from 'node:os';

export const SERVER_URL = 'wss://aux.saradsingh.com.np';

export const IPC_PATH = '/tmp/aux.sock';
export const PID_FILE = '/tmp/aux.pid';

export const AUX_BIN_DIR = join(homedir(), '.aux', 'bin');

export const YT_DLP_VERSION = '2025.01.15';

export const YT_DLP_URL: Record<NodeJS.Platform, string | null> = {
  darwin: `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_macos`,
  linux: `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp`,
  win32: `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp.exe`,
  aix: null, freebsd: null, openbsd: null, sunos: null, netbsd: null, cygwin: null, android: null, haiku: null,
};

export const MPV_WINDOWS_ZIP_URL =
  'https://sourceforge.net/projects/mpv-player-windows/files/64bit/mpv-x86_64-20240901-git-9c6d56f.7z/download';
