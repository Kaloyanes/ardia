import ArdiaDesign

struct LookColors: Equatable, Sendable {
  static let incognito = "incognito"

  var color: String?
  var themeColors: [String]?
  var darkThemeColors: [String]?
  var themeLook: ThemeLook?

  init(color: String? = nil, themeColors: [String]? = nil, darkThemeColors: [String]? = nil, themeLook: ThemeLook? = nil) {
    self.color = color
    self.themeColors = themeColors
    self.darkThemeColors = darkThemeColors
    self.themeLook = themeLook
  }

  init(sent: [String: Any]) {
    self.init(color: sent["color"] as? String, themeColors: sent["themeColors"] as? [String], darkThemeColors: sent["darkThemeColors"] as? [String], themeLook: ThemeLook(sanitizing: sent["themeLook"]))
  }

  var isIncognito: Bool { color == Self.incognito }

  var look: ProfileLook {
    isIncognito ? .incognito : ProfileLook(colorName: color, themeColors: themeColors ?? [], darkThemeColors: darkThemeColors)
  }

  var shownThemeLook: ThemeLook? { isIncognito ? nil : themeLook }

  var withoutThemeLook: LookColors {
    var colors = self
    colors.themeLook = nil
    return colors
  }
}
