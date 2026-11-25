import { existsSync, readFileSync } from "node:fs";
import type { Plugin } from "vite";

export const PIXEL_SCALES = [3, 2] as const;
const SCALED_PREFIX = "\0ardia-scaled:";
const SCALED_PNG = /@\d+x\.png$/;
const PNG_SIGNATURE = "89504e470d0a1a0a";

export type ScaledAsset = { file: string; scale: number; width: number; height: number };

export function pngSize(file: string) {
  const header = readFileSync(file).subarray(0, 24);
  if (header.length < 24 || header.subarray(0, 8).toString("hex") !== PNG_SIGNATURE || header.subarray(12, 16).toString("latin1") !== "IHDR") {
    throw new Error(`${file} is not a PNG`);
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

export function scaledAsset(file: string): ScaledAsset | null {
  if (!file.endsWith(".png") || SCALED_PNG.test(file) || !existsSync(file)) return null;
  const stem = file.slice(0, -".png".length);
  for (const scale of PIXEL_SCALES) {
    const sibling = `${stem}@${scale}x.png`;
    if (existsSync(sibling)) return { file: sibling, scale, ...pngSize(file) };
  }
  return null;
}

export function scaledAssetModule(asset: ScaledAsset) {
  return [
    `import uri from ${JSON.stringify(asset.file)};`,
    `export default { uri, width: ${asset.width}, height: ${asset.height}, scale: ${asset.scale} };`,
  ].join("\n");
}

export function scaledAssets(name: string): Plugin {
  return {
    name,
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!source.endsWith(".png") || importer?.startsWith(SCALED_PREFIX)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external || resolved.id.includes("?")) return null;
      return scaledAsset(resolved.id) ? SCALED_PREFIX + resolved.id : null;
    },
    load(id) {
      if (!id.startsWith(SCALED_PREFIX)) return null;
      const file = id.slice(SCALED_PREFIX.length);
      const asset = scaledAsset(file);
      if (!asset) this.error(`${file} lost its @2x/@3x sibling`);
      this.addWatchFile(file);
      this.addWatchFile(asset.file);
      return scaledAssetModule(asset);
    },
  };
}
