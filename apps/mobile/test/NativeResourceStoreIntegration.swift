import Foundation
import CryptoKit
@main struct NativeResourceStoreIntegration {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), store = HemiResourceStore(root: root), bytes = Data(repeating: 72, count: 1200000)
        func sha(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
        func rejects(_ action: () throws -> Void) throws { do { try action() } catch { return }; throw HemiDeviceError.message("Expected native rejection", "test") }
        let id = try store.begin(name: "../交付报告.txt", size: bytes.count, sha256: sha(bytes))
        try rejects { _ = try store.retain(id: id) }
        try rejects { try store.append(id: id, offset: 1, base64: Data([72]).base64EncodedString()) }
        for offset in stride(from: 0, to: bytes.count, by: 256 * 1024) { try store.append(id: id, offset: offset, base64: bytes.subdata(in: offset..<min(bytes.count, offset + 256 * 1024)).base64EncodedString()) }
        try store.finish(id: id); let url = try store.retain(id: id)
        guard url.lastPathComponent == "交付报告.txt", try Data(contentsOf: url) == bytes else { throw HemiDeviceError.message("Native bytes differ", "test") }
        try store.remove(id: id); guard FileManager.default.fileExists(atPath: url.path) else { throw HemiDeviceError.message("Presentation lost its retained file", "test") }
        store.release(id: id); guard !FileManager.default.fileExists(atPath: url.path) else { throw HemiDeviceError.message("Presentation did not clean bytes", "test") }
        try rejects { _ = try store.begin(name: "bad", size: 20 * 1024 * 1024 + 1, sha256: sha(bytes)) }
        let wrong = try store.begin(name: "wrong.txt", size: 1, sha256: sha(bytes)); try store.append(id: wrong, offset: 0, base64: Data([1]).base64EncodedString()); try rejects { try store.finish(id: wrong) }; try store.remove(id: wrong)
        let empty = try store.begin(name: "empty.txt", size: 0, sha256: sha(Data())); try store.finish(id: empty); _ = try store.retain(id: empty); store.release(id: empty)
        print("PASS native private staging: bounded chunks, SHA-256, size/offset checks, retained presentation, cleanup, empty files")
    }
}
