import { clamp, type Rgb, type Rgba } from "../../../../../third_party/liquid-glass/engine";

export type LiquidGlassTheme = "light" | "dark";
export type LiquidGlassStyle = "regular" | "clear";

export type GlassOptics = {
  bevel: number;
  refraction: number;
  dispersion: number;
  frost: number;
  blur: number;
  clearBlur: number;
  clearBlurEdge: number;
  rim: number;
  rimWidth: number;
  fresnel: number;
  inner: number;
  reflection: number;
  caustic: number;
  mirror: number;
  saturation: number;
  light: number;
  borderAlpha: number;
  borderColor: string;
  tintColor: string;
  shadowOpacity: number;
};

const CRISP: Omit<GlassOptics, "frost" | "blur" | "tintColor" | "borderAlpha" | "saturation" | "light"> = {
  bevel: 0.2,
  refraction: 0.5,
  dispersion: 0.05,
  clearBlur: 0.2,
  clearBlurEdge: 1.1,
  rim: 1,
  rimWidth: 0.55,
  fresnel: 0.45,
  inner: 0.35,
  reflection: 0.3,
  caustic: 0,
  mirror: 0.6,
  borderColor: "rgb(255,255,255)",
  shadowOpacity: 0,
};

export const RIM_MIRROR = { band: 0.25, depth: 0.12, soft: 0.4 };

export const GLASS_OPTICS: Record<LiquidGlassTheme, Record<LiquidGlassStyle, GlassOptics>> = {
  light: {
    regular: { ...CRISP, frost: 0.14, blur: 2, tintColor: "rgb(255,255,255)", borderAlpha: 0.4, saturation: 1.05, light: 0.9 },
    clear: { ...CRISP, frost: 0.06, blur: 0, tintColor: "rgb(255,255,255)", borderAlpha: 0.35, saturation: 1, light: 0.85 },
  },
  dark: {
    regular: { ...CRISP, frost: 0.14, blur: 2, tintColor: "rgb(58,58,62)", borderAlpha: 0.22, saturation: 1.05, light: 0.7 },
    clear: { ...CRISP, frost: 0.06, blur: 0, tintColor: "rgb(255,255,255)", borderAlpha: 0.2, rim: 0.85, saturation: 1, light: 0.65 },
  },
};

export function rgb(color: Rgba): Rgb {
  return [color[0], color[1], color[2]];
}

export function backdropKeyOf(backdrop: unknown, dark: boolean) {
  return `${dark ? "dark" : "light"}|${JSON.stringify(backdrop ?? null)}`;
}

export function tintedGlass(base: Rgb, frost: number, tint: Rgba | null): { color: Rgb; frost: number } {
  if (!tint || tint[3] <= 0) return { color: base, frost };
  const alpha = clamp(tint[3]);
  const cover = 1 - (1 - frost) * (1 - alpha);
  if (cover <= 0) return { color: base, frost };
  const share = alpha / cover;
  return { color: [0, 1, 2].map((i) => base[i]! * (1 - share) + tint[i]! * share) as Rgb, frost: cover };
}
