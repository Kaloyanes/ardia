import { lightsPlaceOffWindow } from "../../browser/src/state/windows/dockMotion";
import { ardiaHost, hostSupports, invokeHost, reportHostError, type ArdiaHost } from "./host";

export const NATIVE_TRAFFIC_LIGHTS = "shell.trafficLights";

export type NativeLightsRequest = { center: { x: number; y: number }; hidden: boolean };

export const drawsNativeTrafficLights = (host: ArdiaHost | null | undefined = ardiaHost): boolean => !!host && hostSupports(NATIVE_TRAFFIC_LIGHTS, host);

export function nativeLightsRequest(center: readonly [number, number] | null, trailing: boolean, windowWidth: number): NativeLightsRequest | null {
  if (!center) return null;
  if (lightsPlaceOffWindow({ center, trailing })) return { center: { x: center[0], y: center[1] }, hidden: true };
  return { center: { x: trailing ? windowWidth - center[0] : center[0], y: center[1] }, hidden: false };
}

export function placeNativeTrafficLights(windowId: string, center: readonly [number, number] | null, trailing: boolean, host: ArdiaHost | null | undefined = ardiaHost, windowWidth = typeof window === "undefined" ? 0 : window.innerWidth): Promise<void> {
  if (!host || !drawsNativeTrafficLights(host) || windowId !== host.bootstrap.windowId) return Promise.resolve();
  const request = nativeLightsRequest(center, trailing, windowWidth) ?? {};
  return invokeHost(NATIVE_TRAFFIC_LIGHTS, request, host).then(() => undefined, reportHostError);
}
