import { engineInfo } from "../../platform/app";
import { queueLog, type ConsentToken } from "./usageClient";

export const NATIVE_MESSAGING_HOST_LOG = "A password manager's native messaging host could not be set up";

type HostReports = NonNullable<Awaited<ReturnType<typeof engineInfo>>["nativeMessagingHosts"]>;

const flag = (value: unknown) => (typeof value === "boolean" ? value : "unknown");

const failed = (report: HostReports[number]) =>
  report.found === false ||
  report.parsed === false ||
  report.executable === false ||
  report.writeErrorDomain !== undefined;

export function failedNativeMessagingHosts(reports: HostReports | undefined) {
  if (!Array.isArray(reports)) return [];
  return reports
    .filter((report) => typeof report?.host === "string" && failed(report))
    .map((report) => ({
      host: report.host,
      found: flag(report.found),
      parsed: flag(report.parsed),
      executable: flag(report.executable),
      writeErrorDomain: typeof report.writeErrorDomain === "string" ? report.writeErrorDomain : "none",
      writeErrorCode: typeof report.writeErrorCode === "number" ? report.writeErrorCode : 0,
    }));
}

export async function reportNativeMessagingHosts(consent: ConsentToken | null) {
  const info = await engineInfo().catch(() => null);
  if (!info) return;
  for (const host of failedNativeMessagingHosts(info.nativeMessagingHosts)) queueLog("warn", NATIVE_MESSAGING_HOST_LOG, host, consent);
}
