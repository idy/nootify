// Run with: swift generate.swift /absolute/path/to/src-tauri/icons
// Uses the same three-cell grid and #235dcc blue as the service's existing UI.
import AppKit

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let iconset = output.appendingPathComponent("Nootify.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

func png(_ pixels: Int, template: Bool = false) -> Data {
    let cg = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8,
        bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    NSGraphicsContext.saveGraphicsState()
    let context = NSGraphicsContext(cgContext: cg, flipped: false)
    NSGraphicsContext.current = context
    context.cgContext.clear(CGRect(x: 0, y: 0, width: pixels, height: pixels))
    if template {
        context.cgContext.scaleBy(x: CGFloat(pixels) / 24, y: CGFloat(pixels) / 24)
        NSColor.black.setFill()
    } else {
        context.cgContext.scaleBy(x: CGFloat(pixels) / 1024, y: CGFloat(pixels) / 1024)
        NSColor.white.setFill()
        NSBezierPath(roundedRect: NSRect(x: 64, y: 64, width: 896, height: 896), xRadius: 196, yRadius: 196).fill()
        NSColor(srgbRed: 225/255, green: 230/255, blue: 237/255, alpha: 1).setStroke()
        let outline = NSBezierPath(roundedRect: NSRect(x: 65, y: 65, width: 894, height: 894), xRadius: 195, yRadius: 195)
        outline.lineWidth = 2
        outline.stroke()
        context.cgContext.translateBy(x: 200, y: 200)
        context.cgContext.scaleBy(x: 26, y: 26)
        NSColor(srgbRed: 35/255, green: 93/255, blue: 204/255, alpha: 1).setFill()
    }
    for rect in [NSRect(x: 2, y: 13, width: 8, height: 8),
                 NSRect(x: 14, y: 3, width: 8, height: 18),
                 NSRect(x: 2, y: 3, width: 8, height: 6)] {
        NSBezierPath(roundedRect: rect, xRadius: 2, yRadius: 2).fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    return NSBitmapImageRep(cgImage: cg.makeImage()!).representation(using: .png, properties: [:])!
}

for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let suffix = scale == 2 ? "@2x" : ""
        try png(points * scale).write(to: iconset.appendingPathComponent("icon_\(points)x\(points)\(suffix).png"))
    }
}
for (name, size) in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 1024)] {
    try png(size).write(to: output.appendingPathComponent(name))
}
try png(44, template: true).write(to: output.appendingPathComponent("tray-template.png"))
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", output.appendingPathComponent("icon.icns").path]
try iconutil.run()
iconutil.waitUntilExit()
if iconutil.terminationStatus != 0 { exit(iconutil.terminationStatus) }
