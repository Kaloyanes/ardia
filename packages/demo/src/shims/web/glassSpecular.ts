export type SpecularLook = {
  rim: string;
  rimOpacity: number;
  ring: string;
  ringFade: string;
  ringOpacity: number;
  sheen: string;
  shadow: string;
  blur: number;
};

const white = (alpha: number) => `rgba(255,255,255,${+alpha.toFixed(4)})`;

export const SPECULAR = {
  dark: { rim: 0.95, ring: 1, sheen: 0.075, contact: 0.3, depth: 0.2 },
  light: { rim: 0.58, ring: 0.7, sheen: 0.16, contact: 0.07, depth: 0.06 },
  clearShare: 0.75,
  rimStops: [[0, 1], [0.32, 0.42], [0.55, 0.16], [0.78, 0.34], [1, 0.82]] as const,
  ringWidth: 1,
  ringFadeStops: [[0, 1], [0.4, 0.3], [0.6, 0.15], [1, 0.7]] as const,
  sheenEnd: 0.48,
  blur: 2,
} as const;

export function specularLook(dark: boolean, clear: boolean): SpecularLook {
  const look = dark ? SPECULAR.dark : SPECULAR.light;
  const share = clear ? SPECULAR.clearShare : 1;
  const rim = SPECULAR.rimStops.map(([at, alpha]) => `${white(alpha)} ${Math.round(at * 100)}%`).join(", ");
  return {
    rim: `linear-gradient(135deg, ${rim})`,
    rimOpacity: +(look.rim * share).toFixed(4),
    ring: `inset 0 0 0 ${SPECULAR.ringWidth}px ${white(1)}`,
    ringFade: `linear-gradient(135deg, ${SPECULAR.ringFadeStops.map(([at, alpha]) => `rgba(0,0,0,${alpha}) ${Math.round(at * 100)}%`).join(", ")})`,
    ringOpacity: +(look.ring * share).toFixed(4),
    sheen: `linear-gradient(160deg, ${white(look.sheen * share)} 0%, ${white(0)} ${Math.round(SPECULAR.sheenEnd * 100)}%)`,
    shadow: `0 0.5px 1px rgba(0,0,0,${look.contact}), 0 3px 10px rgba(0,0,0,${look.depth})`,
    blur: clear ? 0 : SPECULAR.blur,
  };
}

export function withBlur(filter: string, blur: number) {
  return blur > 0 ? `blur(${blur}px) ${filter}` : filter;
}
