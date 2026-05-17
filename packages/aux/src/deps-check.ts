import { existsSync, mkdirSync, createWriteStream, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { AUX_BIN_DIR, YT_DLP_URL, MPV_WINDOWS_ZIP_URL } from './constants.js';

function isOnPath(bin: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(cmd, [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isInAuxBin(name: string): boolean {
  return existsSync(join(AUX_BIN_DIR, name));
}

async function downloadFile(url: string, dest: string): Promise<void> {
  mkdirSync(AUX_BIN_DIR, { recursive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      function get(u: string): void {
        https.get(u, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            get(res.headers.location!);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${res.statusCode} for ${u}`));
            return;
          }
          const out = createWriteStream(dest);
          pipeline(res, out).then(resolve).catch(reject);
        }).on('error', reject);
      }
      get(url);
    });
  } catch (err) {
    try { rmSync(dest, { force: true }); } catch { /* ignore cleanup errors */ }
    throw err;
  }
}

async function ensureYtDlp(): Promise<void> {
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  if (isOnPath('yt-dlp') || isInAuxBin(binName)) return;

  const url = YT_DLP_URL[process.platform];
  if (!url) {
    console.error(`[auxd] yt-dlp not found and no download available for ${process.platform}.`);
    console.error('       Install manually: https://github.com/yt-dlp/yt-dlp#installation');
    process.exit(1);
  }

  console.log('[auxd] downloading yt-dlp...');
  const dest = join(AUX_BIN_DIR, binName);
  await downloadFile(url, dest);
  if (process.platform !== 'win32') chmodSync(dest, 0o755);
  console.log('[auxd] yt-dlp ready');
}

async function ensureMpv(): Promise<void> {
  const binName = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
  if (isOnPath('mpv') || isInAuxBin(binName)) return;

  if (process.platform === 'darwin') {
    console.error('[auxd] mpv not found. Install it with:');
    console.error('       brew install mpv');
    process.exit(1);
  }

  if (process.platform === 'linux') {
    console.error('[auxd] mpv not found. Install it with your package manager:');
    console.error('       Ubuntu/Debian: sudo apt install mpv');
    console.error('       Arch:          sudo pacman -S mpv');
    console.error('       Fedora:        sudo dnf install mpv');
    process.exit(1);
  }

  if (process.platform === 'win32') {
    console.log('[auxd] downloading mpv...');
    const zipDest = join(AUX_BIN_DIR, 'mpv.7z');
    await downloadFile(MPV_WINDOWS_ZIP_URL, zipDest);
    try {
      execFileSync('7z', ['e', zipDest, 'mpv.exe', `-o${AUX_BIN_DIR}`, '-y'], { stdio: 'ignore' });
      console.log('[auxd] mpv ready');
    } catch {
      console.error('[auxd] mpv downloaded but 7z extraction failed.');
      console.error('       Install 7-Zip from https://www.7-zip.org and re-run auxd.');
      process.exit(1);
    }
    return;
  }

  console.error(`[auxd] mpv not found on ${process.platform}. Install manually: https://mpv.io/installation/`);
  process.exit(1);
}

export async function depsCheck(): Promise<void> {
  await ensureYtDlp();
  await ensureMpv();

  // Prepend ~/.aux/bin to PATH so spawned subprocesses find the downloaded binaries
  const pathSep = process.platform === 'win32' ? ';' : ':';
  process.env['PATH'] = `${AUX_BIN_DIR}${pathSep}${process.env['PATH'] ?? ''}`;
}
