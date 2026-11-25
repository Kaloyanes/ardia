#include <dlfcn.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int HasSwitch(int argc, const char* argv[], const char* prefix) {
  for (int i = 1; i < argc; ++i) {
    if (strncmp(argv[i], prefix, strlen(prefix)) == 0) {
      return 1;
    }
  }
  return 0;
}

int main(int argc, const char* argv[]) {
  char executable[PATH_MAX];
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) != 0) {
    return 1;
  }
  char framework[PATH_MAX];
  snprintf(framework, sizeof(framework),
           "%s/../Frameworks/Chromium Framework.framework/Chromium Framework",
           dirname(executable));
  void* library = dlopen(framework, RTLD_LAZY | RTLD_LOCAL | RTLD_FIRST);
  if (!library) {
    fprintf(stderr, "Ardia WebUI: %s\n", dlerror());
    return 1;
  }
  int (*chrome_main)(int, const char**) =
      (int (*)(int, const char**))dlsym(library, "ChromeMain");
  if (!chrome_main) {
    fprintf(stderr, "Ardia WebUI: no ChromeMain in %s\n", framework);
    return 1;
  }
  const char* data = getenv("ARDIA_DATA_DIR");
  const int browser = !HasSwitch(argc, argv, "--type=");
  if (!browser || !data || !*data || HasSwitch(argc, argv, "--user-data-dir=")) {
    return chrome_main(argc, argv);
  }
  const char** args = calloc((size_t)argc + 5, sizeof(char*));
  static char user_data[PATH_MAX + 32];
  static char ardia_data[PATH_MAX + 32];
  snprintf(user_data, sizeof(user_data), "--user-data-dir=%s/Chromium", data);
  snprintf(ardia_data, sizeof(ardia_data), "--ardia-data-dir=%s", data);
  int count = 0;
  for (int i = 0; i < argc; ++i) {
    args[count++] = argv[i];
  }
  args[count++] = user_data;
  args[count++] = ardia_data;
  args[count++] = "--use-mock-keychain";
  if (!HasSwitch(argc, argv, "--ardia-shell=")) {
    args[count++] = "--ardia-shell=webui";
  }
  return chrome_main(count, args);
}
