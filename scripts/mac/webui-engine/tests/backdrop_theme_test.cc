#include "ardia/mac/ac_mac_backdrop_theme.h"

#include <cstdint>
#include <string>

#include "check.h"

namespace theme = ardia_mac::backdrop_theme;

namespace {

std::uint32_t Digest(const std::array<std::uint8_t, theme::kGrainSide * theme::kGrainSide>& alpha) {
  std::uint32_t sum = 0;
  for (std::uint8_t value : alpha) sum = sum * 31 + value;
  return sum;
}

}

TEST(native_grain_matches_the_shell_tiles_byte_for_byte) {
  struct Expected {
    const char* texture;
    int first[6];
    int at5000;
    int last;
    std::uint32_t digest;
  };
  const Expected expected[] = {
      {"grain", {42, 4, 37, 17, 53, 43}, 0, 52, 2775126470u},
      {"sand", {86, 50, 83, 67, 93, 87}, 41, 92, 2383342204u},
      {"denim", {63, 52, 30, 29, 65, 63}, 22, 25, 1129773121u},
      {"tweed", {74, 69, 73, 71, 75, 74}, 67, 75, 1663753000u},
      {"film", {255, 26, 56, 147, 98, 217}, 89, 233, 590679545u},
  };
  for (const Expected& row : expected) {
    const auto alpha = theme::GrainAlpha(row.texture);
    for (std::size_t i = 0; i < 6; ++i) CHECK(alpha[i] == row.first[i]);
    CHECK(alpha[5000] == row.at5000);
    CHECK(alpha[16383] == row.last);
    CHECK(Digest(alpha) == row.digest);
  }
}

TEST(textures_and_cells_are_bounded) {
  for (const char* known : {"film", "grain", "sand", "denim", "tweed"}) CHECK(theme::KnownTexture(known));
  for (const char* unknown : {"", "Film", "../x", "noise"}) CHECK(!theme::KnownTexture(unknown));
  CHECK(theme::GrainCellPixels(128, 2) == 2);
  CHECK(theme::GrainCellPixels(64, 2) == 1);
  CHECK(theme::GrainCellPixels(128, 1) == 1);
  CHECK(theme::GrainCellPixels(1e12, 2) == 16);
  CHECK(theme::GrainCellPixels(std::nan(""), std::nan("")) == 1);
  CHECK(theme::GrainCellPixels(-5, 2) == 2);
  CHECK(theme::Unit(std::nan("")) == 0 && theme::Unit(4) == 1 && theme::Unit(-1) == 0);
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
