// Run with: swift generate.swift /absolute/path/to/src-tauri/icons
// Renders icon.svg into the app icon PNG, ICNS, and ICO files, and desktop/brand.svg into the black macOS tray template.
import AppKit

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let icon = NSImage(contentsOf: output.appendingPathComponent("icon.svg"))!
let mark = NSImage(contentsOf: output.appendingPathComponent("../../desktop/brand.svg"))!

func png(_ pixels: Int, template: Bool = false) -> Data {
    let cg = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8,
        bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: false)
    let canvas = NSRect(x: 0, y: 0, width: pixels, height: pixels)
    if template {
        // A 26-unit canvas keeps the 24-unit glyph about 18 pt tall in the 22 pt menu-bar slot.
        let margin = CGFloat(pixels) / 26
        mark.draw(in: canvas.insetBy(dx: margin, dy: margin))
        NSColor.black.set()
        canvas.fill(using: .sourceIn)
    } else {
        icon.draw(in: canvas)
    }
    NSGraphicsContext.restoreGraphicsState()
    return NSBitmapImageRep(cgImage: cg.makeImage()!).representation(using: .png, properties: [:])!
}

for (name, size) in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 1024)] {
    try png(size).write(to: output.appendingPathComponent(name))
}
try png(44, template: true).write(to: output.appendingPathComponent("tray-template.png"))

// ICO: a directory of 16-byte entries followed by PNG images; a size byte of 0 means 256.
let icoImages = [16, 24, 32, 48, 64, 256].map { ($0, png($0)) }
var ico = Data([0, 0, 1, 0, UInt8(icoImages.count), 0])
var offset = 6 + 16 * icoImages.count
for (size, image) in icoImages {
    ico.append(contentsOf: [UInt8(size % 256), UInt8(size % 256), 0, 0, 1, 0, 32, 0])
    for value in [image.count, offset] {
        withUnsafeBytes(of: UInt32(value).littleEndian) { ico.append(contentsOf: $0) }
    }
    offset += image.count
}
for (_, image) in icoImages { ico.append(image) }
try ico.write(to: output.appendingPathComponent("icon.ico"))

let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("Nootify-\(UUID().uuidString).iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let suffix = scale == 2 ? "@2x" : ""
        try png(points * scale).write(to: iconset.appendingPathComponent("icon_\(points)x\(points)\(suffix).png"))
    }
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", output.appendingPathComponent("icon.icns").path]
try iconutil.run()
iconutil.waitUntilExit()
try? FileManager.default.removeItem(at: iconset)
if iconutil.terminationStatus != 0 { exit(iconutil.terminationStatus) }
