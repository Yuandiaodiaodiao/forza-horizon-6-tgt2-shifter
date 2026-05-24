import { existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { BUILD_SHA, BUILD_TAG, BUILD_TIME, UPDATE_REPO } from "./build_info";
import { envBool } from "./env";

interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  assets: ReleaseAsset[];
}

const EXE_ASSET_RE = /^tgt2-telemetry-.+\.exe$/i;

export async function applyStartupUpdate(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  if (process.argv.includes("--no-update")) return false;
  if (!envBool("TGT2_AUTO_UPDATE", true)) return false;

  try {
    const target = await downloadLatestUpdate();
    if (!target) return false;
    console.log(`  Update: downloaded ${target}; restart the app manually to apply it`);
    return false;
  } catch (e) {
    console.log(`  Update: skipped (${e instanceof Error ? e.message : String(e)})`);
    return false;
  }
}

export function startBackgroundUpdateDownload() {
  if (process.platform !== "win32") return;
  if (process.argv.includes("--no-update")) return;
  if (!envBool("TGT2_AUTO_UPDATE", true)) return;

  queueMicrotask(() => {
    void downloadLatestUpdate()
      .then((target) => {
        if (target) console.log(`  Update: downloaded ${target}; restart the app manually to apply it`);
      })
      .catch((e) => {
        console.log(`  Update: background download skipped (${e instanceof Error ? e.message : String(e)})`);
      });
  });
}

export function getBuildInfo() {
  return {
    tag: BUILD_TAG,
    sha: BUILD_SHA,
    time: BUILD_TIME,
    repo: UPDATE_REPO,
  };
}

async function downloadLatestUpdate(): Promise<string | null> {
  const latest = await fetchLatestRelease();
  if (!latest || latest.draft || latest.prerelease) return null;
  if (latest.tag_name === BUILD_TAG) {
    console.log(`  Update: current build is latest (${BUILD_TAG})`);
    return null;
  }

  const asset = latest.assets.find((item) => EXE_ASSET_RE.test(item.name));
  if (!asset) {
    console.log(`  Update: latest release ${latest.tag_name} has no Windows exe asset`);
    return null;
  }

  const target = join(process.cwd(), asset.name);
  if (existsSync(target) && statSync(target).size === asset.size) return target;
  await downloadAsset(asset, target);
  return target;
}

async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  const resp = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "tgt2-telemetry-updater",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`latest release HTTP ${resp.status}`);
  return await resp.json() as GitHubRelease;
}

async function downloadAsset(asset: ReleaseAsset, target: string) {
  const temp = `${target}.download`;
  console.log(`  Update: downloading ${asset.name} (${asset.size} bytes)`);
  const resp = await fetch(asset.browser_download_url, {
    headers: { "User-Agent": "tgt2-telemetry-updater" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) throw new Error(`download HTTP ${resp.status}`);
  await Bun.write(temp, await resp.arrayBuffer());
  const size = statSync(temp).size;
  if (asset.size > 0 && size !== asset.size) {
    throw new Error(`downloaded size mismatch: ${size} != ${asset.size}`);
  }
  renameSync(temp, target);
}
