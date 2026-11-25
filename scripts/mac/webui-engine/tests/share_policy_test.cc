#include "ardia/mac/ac_mac_share_policy.h"

#include <cmath>
#include <limits>
#include <string>

#include "check.h"

namespace policy = ardia_mac::share_policy;

TEST(anchors_need_four_finite_coordinates) {
  const double good[] = {10, 20, 30, 40};
  const auto anchor = policy::AnchorFrom(4, good);
  CHECK(anchor && anchor->x == 10 && anchor->height == 40);
  CHECK(!policy::AnchorFrom(3, good));
  CHECK(!policy::AnchorFrom(4, nullptr));
  const double nan[] = {std::numeric_limits<double>::quiet_NaN(), 0, 1, 1};
  CHECK(!policy::AnchorFrom(4, nan));
  const double huge[] = {1e20, 0, 1, 1};
  CHECK(!policy::AnchorFrom(4, huge));
  const double negative[] = {0, 0, -1, 1};
  CHECK(!policy::AnchorFrom(4, negative));
}

TEST(default_anchor_sits_centred_below_the_toolbar) {
  const auto anchor = policy::DefaultAnchor(1000);
  CHECK_NEAR(anchor.x, 499);
  CHECK_NEAR(anchor.y, 40);
  CHECK_NEAR(anchor.width, 2);
  CHECK(policy::DefaultAnchor(std::numeric_limits<double>::infinity()).x == -1);
}

TEST(edges_face_the_middle_of_the_window) {
  CHECK(policy::EdgeFor(std::nullopt, 1000) == policy::Edge::kBelow);
  CHECK(policy::EdgeFor(policy::Anchor{10, 10, 20, 20}, 1000) == policy::Edge::kTrailing);
  CHECK(policy::EdgeFor(policy::Anchor{900, 10, 20, 20}, 1000) == policy::Edge::kLeading);
}

TEST(zoom_is_sanitized) {
  const auto scaled = policy::Scaled(policy::Anchor{10, 10, 10, 10}, 2);
  CHECK_NEAR(scaled.x, 20);
  CHECK_NEAR(policy::Scaled(policy::Anchor{10, 10, 10, 10}, std::numeric_limits<double>::quiet_NaN()).x, 10);
  CHECK_NEAR(policy::Scaled(policy::Anchor{10, 10, 10, 10}, 1e9).x, 10);
}

TEST(only_web_and_file_links_are_shared) {
  CHECK(policy::ClassifyUrl("https://ardia.dev/") == policy::UrlKind::kWeb);
  CHECK(policy::ClassifyUrl("HTTP://ardia.dev/") == policy::UrlKind::kWeb);
  CHECK(policy::ClassifyUrl("file:///Users/me/Shared") == policy::UrlKind::kFile);
  CHECK(policy::ClassifyUrl("file://host/share") == policy::UrlKind::kRefused);
  CHECK(policy::ClassifyUrl("javascript:alert(1)") == policy::UrlKind::kRefused);
  CHECK(policy::ClassifyUrl("data:text/html,x") == policy::UrlKind::kRefused);
  CHECK(policy::ClassifyUrl("chrome://ardia/") == policy::UrlKind::kRefused);
  CHECK(policy::ClassifyUrl("https://a.b/\nx") == policy::UrlKind::kRefused);
  CHECK(policy::ClassifyUrl("") == policy::UrlKind::kRefused);
  CHECK(policy::ClassifyUrl("https://" + std::string(policy::kMaxUrlBytes, 'a')) == policy::UrlKind::kRefused);
}

TEST(text_titles_and_services_are_bounded) {
  CHECK(policy::ShareableText("hello"));
  CHECK(!policy::ShareableText(""));
  CHECK(!policy::ShareableText(std::string(policy::kMaxTextBytes + 1, 'a')));
  CHECK(policy::ValidTitle(std::string(policy::kMaxTitleBytes, 'a')));
  CHECK(!policy::ValidTitle(std::string(policy::kMaxTitleBytes + 1, 'a')));
  CHECK(policy::ValidServiceName("AirDrop"));
  CHECK(!policy::ValidServiceName(""));
  CHECK(!policy::ValidServiceName("Air\nDrop"));
}

TEST(temporary_files_stay_inside_their_directory) {
  CHECK(policy::InsideDirectory("/tmp/images/a.png", "/tmp/images"));
  CHECK(policy::InsideDirectory("/tmp/images/a.png", "/tmp/images/"));
  CHECK(!policy::InsideDirectory("/tmp/images", "/tmp/images"));
  CHECK(!policy::InsideDirectory("/tmp/images/../secret", "/tmp/images"));
  CHECK(!policy::InsideDirectory("/tmp/images/sub/a.png", "/tmp/images"));
  CHECK(!policy::InsideDirectory("/tmp/imagesx/a.png", "/tmp/images"));
  CHECK(!policy::InsideDirectory("/tmp/images/./a.png", "/tmp/images"));
  CHECK(!policy::InsideDirectory("relative/a.png", "/tmp/images"));
  CHECK(!policy::CleanAbsolutePath("/a//b"));
  CHECK(policy::CleanAbsolutePath("/a/b/"));
}

TEST(page_shares_match_ardiacore) {
  policy::PageShareInput page;
  page.page_is_web = true;
  CHECK((policy::SharesFor(page) == std::vector{policy::PageShare::kPage}));
  policy::PageShareInput link = page;
  link.link_is_web = true;
  link.has_selection = true;
  link.selection_is_link_text = true;
  CHECK((policy::SharesFor(link) == std::vector{policy::PageShare::kLink}));
  link.selection_is_link_text = false;
  CHECK((policy::SharesFor(link) == std::vector{policy::PageShare::kText, policy::PageShare::kLink}));
  policy::PageShareInput image = page;
  image.media = policy::PageMedia::kImage;
  image.has_image_contents = true;
  CHECK((policy::SharesFor(image) == std::vector{policy::PageShare::kImage}));
  image.has_image_contents = false;
  CHECK(policy::SharesFor(image).empty());
  policy::PageShareInput editable = link;
  editable.editable = true;
  CHECK(policy::SharesFor(editable).empty());
  policy::PageShareInput video = page;
  video.media = policy::PageMedia::kVideo;
  CHECK(policy::SharesFor(video).empty());
  video.source_is_web = true;
  CHECK((policy::SharesFor(video) == std::vector{policy::PageShare::kVideo}));
}

TEST(page_share_titles_and_kinds) {
  CHECK(policy::ShareTitle(policy::PageShare::kLink, true) == "Share…");
  CHECK(policy::ShareTitle(policy::PageShare::kLink, false) == "Share Link…");
  CHECK(policy::ShareTitle(policy::PageShare::kImage, false) == "Share Image…");
  CHECK(policy::KindName(policy::PageShare::kText) == "text");
  CHECK(policy::ImageExtension("image/jpeg") == "jpg");
  CHECK(policy::ImageExtension("text/html") == "png");
}

TEST(hostile_sinks) {
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const double inf = std::numeric_limits<double>::infinity();
  for (double a : {nan, inf, -inf, 1e20, 1e308, -0.0, 4.9e-324}) {
    const double values[] = {a, a, a, a};
    if (const auto anchor = policy::AnchorFrom(4, values)) {
      CHECK(std::isfinite(anchor->x) && anchor->width >= 0);
    }
    const auto scaled = policy::Scaled(policy::Anchor{1, 1, 1, 1}, a);
    CHECK(std::isfinite(scaled.x));
    CHECK(std::isfinite(policy::DefaultAnchor(a).x));
  }
  for (const char* url : {"file:///../../etc/passwd", "vbscript:x", " https://x", "https://x\x7f"}) {
    CHECK(policy::ClassifyUrl(url) != policy::UrlKind::kWeb);
  }
  CHECK(!policy::InsideDirectory(std::string("/tmp/images/a\0b", 15), "/tmp/images"));
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
