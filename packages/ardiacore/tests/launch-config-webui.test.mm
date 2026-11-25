#import "../ios/ArdiaLaunchConfig.h"

#include <cstdio>

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

static NSString *const kExecutable = @"/Applications/Ardia Dev.app/Contents/MacOS/Ardia";

static ArdiaLaunchConfig *Config(NSDictionary<NSString *, NSString *> *environment, NSArray<NSString *> *arguments = @[]) {
  return [[ArdiaLaunchConfig alloc] initWithEnvironment:environment
                                              arguments:[@[ kExecutable ] arrayByAddingObjectsFromArray:arguments]
                                  signedForDistribution:^BOOL { return NO; }];
}

static void EveryRequest(void (^check)(ArdiaLaunchConfig *config)) {
  check(Config(@{@"ARDIA_SHELL" : @"webui"}));
  check(Config(@{@"ARDIA_SHELL" : @" WebUI "}));
  check(Config(@{}, @[ @"--ardia-shell=webui" ]));
  check(Config(@{}, @[ @"--x", @"--ardia-shell=WEBUI" ]));
  check(Config(@{@"ARDIA_SHELL" : @"webui", @"ARDIA_WEBUI_APP" : @"/tmp/Ardia WebUI.app", @"ARDIA_WEBUI_HANDED_OFF" : @"1"}, @[ @"--ardia-shell=webui" ]));
}

static void Neither() {
  for (ArdiaLaunchConfig *config in @[
         Config(@{}), Config(@{@"ARDIA_SHELL" : @"native"}), Config(@{@"ARDIA_SHELL" : @""}), Config(@{@"ARDIA_SHELL_X" : @"webui"}),
         Config(@{}, @[ @"--ardia-shell=native" ]), Config(@{}, @[ @"--ardia-shell", @"webui" ]),
       ]) {
    CHECK(!config.webUIShell);
    CHECK(config.dataDirectory == nil);
    CHECK(!config.isolated);
    CHECK(!config.webUIDataDirectoryDefaulted);
  }
  ArdiaLaunchConfig *executableOnly = [[ArdiaLaunchConfig alloc] initWithEnvironment:@{}
                                                                           arguments:@[ @"--ardia-shell=webui" ]
                                                               signedForDistribution:^BOOL { return NO; }];
  CHECK(!executableOnly.webUIShell);
}

#if DEBUG
static NSString *DevDataDirectory() {
  return [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/Ardia WebUI Dev"];
}

static NSString *LiveProfile() {
  return [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/Ardia"];
}

static void DebugBuild() {
  Neither();
  EveryRequest(^(ArdiaLaunchConfig *config) {
    CHECK(config.webUIShell);
    CHECK([config.snapshot[@"webUIShell"] isEqual:@YES]);
    CHECK([config.dataDirectory isEqualToString:DevDataDirectory()]);
    CHECK(![config.dataDirectory isEqualToString:LiveProfile()]);
    CHECK(config.webUIDataDirectoryDefaulted);
    CHECK(config.isolated);
    CHECK([config.configDirectory isEqualToString:[DevDataDirectory() stringByAppendingPathComponent:@"config"]]);
    CHECK([config.engineSwitches containsObject:[@"--ardia-data-dir=" stringByAppendingString:DevDataDirectory()]]);
  });
  ArdiaLaunchConfig *explicitDirectory = Config(@{@"ARDIA_SHELL" : @"webui", @"ARDIA_DATA_DIR" : @"/tmp/scratch-webui"});
  CHECK(explicitDirectory.webUIShell);
  CHECK([explicitDirectory.dataDirectory isEqualToString:@"/tmp/scratch-webui"]);
  CHECK(!explicitDirectory.webUIDataDirectoryDefaulted);
  ArdiaLaunchConfig *host = Config(@{@"ARDIA_SHELL" : @"webui", @"ARDIA_WEBUI_APP" : @"/tmp/Ardia WebUI.app", @"ARDIA_WEBUI_HANDED_OFF" : @"1"});
  CHECK([host.webUIHostApp isEqualToString:@"/tmp/Ardia WebUI.app"]);
  CHECK(host.webUIHandedOff);
  ArdiaLaunchConfig *unrequested = Config(@{@"ARDIA_WEBUI_APP" : @"/tmp/Ardia WebUI.app", @"ARDIA_WEBUI_HANDED_OFF" : @"1"});
  CHECK(unrequested.webUIHostApp == nil);
  CHECK(!unrequested.webUIHandedOff);
}
#else
static void ReleaseBuild() {
  Neither();
  EveryRequest(^(ArdiaLaunchConfig *config) {
    CHECK(!config.webUIShell);
    CHECK([config.snapshot[@"webUIShell"] isEqual:@NO]);
    CHECK(config.dataDirectory == nil);
    CHECK(!config.isolated);
    CHECK(!config.webUIDataDirectoryDefaulted);
    CHECK(config.webUIHostApp == nil);
    CHECK(!config.webUIHandedOff);
  });
  ArdiaLaunchConfig *explicitDirectory = Config(@{@"ARDIA_SHELL" : @"webui", @"ARDIA_DATA_DIR" : @"/tmp/scratch-webui"});
  CHECK(!explicitDirectory.webUIShell);
  CHECK([explicitDirectory.dataDirectory isEqualToString:@"/tmp/scratch-webui"]);
}
#endif

int main() {
  @autoreleasepool {
#if DEBUG
    DebugBuild();
    std::printf("launch-config-webui debug: %d failures\n", failures);
#else
    ReleaseBuild();
    std::printf("launch-config-webui release: %d failures\n", failures);
#endif
  }
  return failures ? 1 : 0;
}
