// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AriMeetingCapture",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "AriMeetingCapture", targets: ["AriMeetingCapture"])],
    targets: [.executableTarget(name: "AriMeetingCapture")]
)
