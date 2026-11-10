import AppKit

// Keep Running's artwork intact; this entry point only exports the assets Toolbelt uses.
@MainActor
func render() throws {
    try AppArt.renderIconset(to: URL(fileURLWithPath: "icon.iconset"), dev: false)
    try AppArt.renderIconset(to: URL(fileURLWithPath: "dev-icon.iconset"), dev: true)
    try FileManager.default.createDirectory(atPath: "assets", withIntermediateDirectories: true)
    for (name, size, alert, tint, appearance) in [
        ("tray-icon.png", 18, false, nil, NSAppearance.Name.aqua),
        ("tray-icon@2x.png", 36, false, nil, NSAppearance.Name.aqua),
        ("tray-icon-dev@2x.png", 36, false, NSColor.systemOrange, NSAppearance.Name.aqua),
        ("tray-icon-update-light@2x.png", 36, true, nil, NSAppearance.Name.aqua),
        ("tray-icon-update-dark@2x.png", 36, true, nil, NSAppearance.Name.darkAqua),
    ] as [(String, Int, Bool, NSColor?, NSAppearance.Name)] {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                   bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                   isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSAppearance(named: appearance)!.performAsCurrentDrawingAppearance {
            let image = AppArt.menuBarImage(alert: alert, tint: tint)
            let scale = CGFloat(size) / image.size.width
            image.draw(in: NSRect(x: 0, y: (CGFloat(size) - image.size.height * scale) / 2,
                                  width: CGFloat(size), height: image.size.height * scale))
        }
        NSGraphicsContext.restoreGraphicsState()
        try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "assets/\(name)"))
    }
}

do {
    try MainActor.assumeIsolated { try render() }
} catch {
    FileHandle.standardError.write(Data("render-icons failed: \(error)\n".utf8))
    exit(1)
}
