// Run with: swift generate.swift /absolute/path/to/src-tauri/icons
// Draws the penguin from desktop/brand.svg in the UI's #27272a text color on a white plate, and in black for the tray template.
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
        // A 26-unit canvas keeps the glyph about 18 pt tall in the 22 pt menu-bar slot.
        context.cgContext.scaleBy(x: CGFloat(pixels) / 26, y: CGFloat(pixels) / 26)
        context.cgContext.translateBy(x: 1, y: 1)
        NSColor.black.set()
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
        NSColor(srgbRed: 39/255, green: 39/255, blue: 42/255, alpha: 1).set()
    }
    // From here on, brand.svg's y-down coordinates inside its rotate(14 12 12).
    context.cgContext.translateBy(x: 12, y: 12)
    context.cgContext.scaleBy(x: 1, y: -1)
    context.cgContext.rotate(by: 14 * .pi / 180)
    context.cgContext.translateBy(x: -12, y: -12)
    let body = NSBezierPath(roundedRect: NSRect(x: 5.4, y: 1.2, width: 12.4, height: 21.6), xRadius: 6.2, yRadius: 6.2)
    body.append(NSBezierPath(roundedRect: NSRect(x: 8.8, y: 10, width: 7.4, height: 10.9), xRadius: 3.7, yRadius: 3.7))
    body.append(NSBezierPath(ovalIn: NSRect(x: 12.2, y: 4.8, width: 2, height: 2)))
    body.windingRule = .evenOdd
    body.fill()
    // brand.svg's beak path is this triangle grown by a 0.3 round join; its first corner hides inside the head.
    let beak = NSBezierPath()
    beak.move(to: NSPoint(x: 16.4, y: 4.13))
    beak.line(to: NSPoint(x: 20.8, y: 6.2))
    beak.line(to: NSPoint(x: 17.4, y: 7.8))
    beak.close()
    beak.lineWidth = 0.6
    beak.lineJoinStyle = .round
    beak.fill()
    beak.stroke()
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
