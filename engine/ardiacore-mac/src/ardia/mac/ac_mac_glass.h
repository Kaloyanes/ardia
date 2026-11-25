#ifndef ARDIA_MAC_AC_MAC_GLASS_H_
#define ARDIA_MAC_AC_MAC_GLASS_H_

#include <memory>
#include <string>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "ui/gfx/geometry/rect.h"

namespace views {
class Widget;
}

namespace ardia_mac {

struct GlassRegion {
  gfx::Rect rect;
  double radius = 0;
  std::string material;
  std::string kind;
};

class GlassRegions {
 public:
  explicit GlassRegions(views::Widget* widget);
  GlassRegions(const GlassRegions&) = delete;
  GlassRegions& operator=(const GlassRegions&) = delete;
  ~GlassRegions();

  void Apply(const std::vector<GlassRegion>& regions);

 private:
  struct Views;
  raw_ptr<views::Widget> widget_;
  std::unique_ptr<Views> views_;
};

}

#endif
