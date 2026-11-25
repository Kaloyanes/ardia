#ifndef ARDIA_MAC_AC_MAC_SWIPE_H_
#define ARDIA_MAC_AC_MAC_SWIPE_H_

#include <memory>

#include "base/values.h"

namespace views {
class Widget;
}

namespace ardia_mac {

class ShellHostView;

class ScrollGestures {
 public:
  ScrollGestures(ShellHostView* host, views::Widget* widget);
  ScrollGestures(const ScrollGestures&) = delete;
  ScrollGestures& operator=(const ScrollGestures&) = delete;
  ~ScrollGestures();

  static void AppendCapabilities(base::ListValue& capabilities);

  struct Native;

 private:
  std::unique_ptr<Native> state_;
};

}

#endif
