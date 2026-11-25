import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const read = (name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

const messaging = read("../ios/ArdiaNativeMessaging.mm");
const header = read("../ios/ArdiaNativeMessaging.h");
const host = read("../ios/ArdiaHost.mm");
const domain = read("../src/engineDomain.ts");

const body = (source, signature) => {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} exists`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${signature} has no end`);
};

test("the system host loop records whether the manifest was found, parsed, and pointed at an executable, from the same read it uses", () => {
  const loop = body(messaging, "for (NSString *name in SystemRegisteredHosts())");
  assert.match(loop, /NSData \*system = \[NSData dataWithContentsOfFile:ManifestPath\(kChromeSystemDir, name\)\]/);
  assert.match(loop, /NoteReport\(name, @\{[^}]*@"found" : @\(system != nil\)/);
  assert.match(loop, /@"parsed" : @\(\[parsed isKindOfClass:NSDictionary\.class\]\)/);
  assert.match(loop, /@"executable" : @\(HasExecutableTarget\(parsed\)\)/);
  assert.match(loop, /if \(system && IsUsable\(parsed, name\)\) hosts\[name\] = system;/);
});

test("the usability rule itself is unchanged: name, stdio, allowed origins and an absolute executable path", () => {
  const usable = body(messaging, "bool IsUsable(");
  assert.match(usable, /manifest\[@"name"\] isEqual:name/);
  assert.match(usable, /manifest\[@"type"\] isEqual:@"stdio"/);
  assert.match(usable, /manifest\[@"allowed_origins"\] isKindOfClass:NSArray\.class/);
  assert.match(usable, /HasExecutableTarget\(manifest\)/);
  const target = body(messaging, "bool HasExecutableTarget(");
  assert.match(target, /path\.isAbsolutePath/);
  assert.match(target, /isExecutableFileAtPath:path/);
});

test("a manifest write that fails records the error's domain and code before the host is skipped, and is still skipped", () => {
  const sync = body(messaging, "void SyncHosts(");
  assert.match(sync, /NSError \*writeError = nil;/);
  assert.match(sync, /writeToFile:path options:NSDataWritingAtomic error:&writeError/);
  assert.match(
    sync,
    /NoteReport\(name, @\{ @"writeErrorDomain" : writeError\.domain \?: @"", @"writeErrorCode" : @\(writeError\.code\) \}\);\s*continue;/,
  );
  assert.ok(sync.indexOf("BeginReport();") >= 0 && sync.indexOf("BeginReport();") < sync.indexOf("InstalledHosts()"));
});

test("the report holds only the host name from the fixed lists, three flags and the error's domain and code: no paths, manifest contents or error text", () => {
  const notes = [...messaging.matchAll(/NoteReport\(name, (@\{[^;]*\})\);/g)].map((m) => m[1]);
  assert.equal(notes.length, 2);
  const keys = notes.flatMap((note) => [...note.matchAll(/@"(\w+)" :/g)].map((m) => m[1])).sort();
  assert.deepEqual(keys, ["executable", "found", "parsed", "writeErrorCode", "writeErrorDomain"]);
  const report = body(messaging, "void NoteReport(");
  assert.match(report, /dictionaryWithObject:name forKey:@"host"/);
  assert.doesNotMatch(messaging, /NSLog|os_log|localizedDescription|userInfo|NSFilePath/);
});

test("the report is rebuilt on every sync under a lock and read by the engine info as sorted copies", () => {
  assert.match(messaging, /os_unfair_lock gReportLock = OS_UNFAIR_LOCK_INIT;/);
  const reports = body(messaging, "NSArray<NSDictionary<NSString *, id> *> *HostReports()");
  assert.match(reports, /os_unfair_lock_lock\(&gReportLock\)/);
  assert.match(reports, /sortedArrayUsingSelector:@selector\(compare:\)/);
  assert.match(reports, /\[Report\(\)\[name\] copy\]/);
  assert.match(reports, /os_unfair_lock_unlock\(&gReportLock\)/);
  assert.match(header, /NSArray<NSDictionary<NSString \*, id> \*> \*HostReports\(\);/);
});

test("the engine info carries the report to the app, and its type lists the same fields", () => {
  assert.match(host, /#import "ArdiaNativeMessaging\.h"/);
  assert.match(host, /@"nativeMessagingHosts" : ardia_native_messaging::HostReports\(\),/);
  const type = body(domain, "export type NativeMessagingHostReport");
  for (const field of ["host: string", "found?: boolean", "parsed?: boolean", "executable?: boolean", "writeErrorDomain?: string", "writeErrorCode?: number"])
    assert.ok(type.includes(field), field);
  assert.match(body(domain, "export type EngineInfo"), /nativeMessagingHosts\?: NativeMessagingHostReport\[\];/);
});
