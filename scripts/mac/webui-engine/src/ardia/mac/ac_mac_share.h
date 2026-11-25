#ifndef ARDIA_MAC_AC_MAC_SHARE_H_
#define ARDIA_MAC_AC_MAC_SHARE_H_

#include <string>
#include <string_view>

#include "ardia/mac/ac_mac_shell_host.h"
#include "base/values.h"

namespace ardia_mac::share {

bool Handles(std::string_view method);
void AppendCapabilities(base::ListValue& capabilities);
void Invoke(ShellHostView& host,
            const std::string& method,
            const base::ListValue* values,
            ShellHostView::Done done);
void InstallPageMenu();

}

#endif
