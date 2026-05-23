import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_DATA_DIR } from "./config";
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
    const latest = await fetchLatestRelease();
    if (!latest || latest.draft || latest.prerelease) return false;
    if (latest.tag_name === BUILD_TAG) {
      console.log(`  Update: current build is latest (${BUILD_TAG})`);
      return false;
    }

    const asset = latest.assets.find((item) => EXE_ASSET_RE.test(item.name));
    if (!asset) {
      console.log(`  Update: latest release ${latest.tag_name} has no Windows exe asset`);
      return false;
    }

    const target = join(APP_DATA_DIR, "updates", latest.tag_name, asset.name);
    if (!existsSync(target) || statSync(target).size !== asset.size) {
      await downloadAsset(asset, target);
    }

    console.log(
      `  Update: ${BUILD_TAG} (${BUILD_SHA}) -> ${latest.tag_name}; restarting with ${target}`
    );
    restartInto(target);
    return true;
  } catch (e) {
    console.log(`  Update: skipped (${e instanceof Error ? e.message : String(e)})`);
    return false;
  }
}

export function getBuildInfo() {
  return {
    tag: BUILD_TAG,
    sha: BUILD_SHA,
    time: BUILD_TIME,
    repo: UPDATE_REPO,
  };
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
  mkdirSync(dirname(target), { recursive: true });
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

function restartInto(exePath: string) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--no-update");
  const cmd = `start "" ${quoteCmd(exePath)} ${args.map(quoteCmd).join(" ")}`;
  Bun.spawn(["cmd", "/c", cmd], {
    cwd: dirname(exePath),
    stdout: "ignore",
    stderr: "ignore",
  });
  process.exit(0);
}

function quoteCmd(value: string) {
  return `"${value.replace(/"/g, '\\"')}"`;
}
