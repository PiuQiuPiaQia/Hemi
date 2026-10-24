import Foundation
private final class ResourceCredentialStore: HemiCredentialStore {
    var values: [String: Data] = [:]
    func read(_ name: String) throws -> Data? { values[name] }
    func write(_ name: String, _ data: Data?) throws { values[name] = data }
}
@main struct NativeResourceDeviceIntegration {
    static func main() async throws {
        let args = CommandLine.arguments, folder = URL(fileURLWithPath: args[1]), client = HemiDeviceClient(store: ResourceCredentialStore())
        _ = try await client.prepare(String(contentsOf: folder.appendingPathComponent("invite.json"), encoding: .utf8), name: "Isolated native file test")
        _ = try await client.pairRequest(); var approved = false
        for _ in 0..<30 { if try await client.pairStatus()["status"] as? String == "approved" { approved = true; break }; try await Task.sleep(nanoseconds: 200_000_000) }
        guard approved else { throw HemiDeviceError.message("Isolated approval timeout", "test") }
        let params: [String: Any] = ["id": args[2], "kind": "deliverable", "artifactId": args[3]]
        let envelope = try await client.request(method: "resource.stat", params: params)
        guard let info = envelope["result"] as? [String: Any], let name = info["name"] as? String, let size = info["size"] as? Int, let sha = info["sha256"] as? String, let version = info["version"] as? String else { throw HemiDeviceError.message("Invalid real resource metadata", "test") }
        let store = HemiResourceStore(root: folder.appendingPathComponent("cache")), id = try store.begin(name: name, size: size, sha256: sha)
        let chunkSize = min(1024 * 1024, info["chunkSize"] as? Int ?? 256 * 1024)
        for offset in stride(from: 0, to: size, by: chunkSize) {
            var chunk = params; chunk["version"] = version; chunk["offset"] = offset; chunk["length"] = chunkSize
            let result = try await client.request(method: "resource.chunk", params: chunk)
            guard let part = result["result"] as? [String: Any], let base64 = part["base64"] as? String else { throw HemiDeviceError.message("Missing native chunk", "test") }
            guard let bytes = Data(base64Encoded: base64) else { throw HemiDeviceError.message("Invalid native chunk", "test") }
            for localOffset in stride(from: 0, to: bytes.count, by: 256 * 1024) { try store.append(id: id, offset: offset + localOffset, base64: bytes.subdata(in: localOffset..<min(bytes.count, localOffset + 256 * 1024)).base64EncodedString()) }
        }
        try store.finish(id: id); let url = try store.retain(id: id)
        guard try Data(contentsOf: url) == Data(repeating: 72, count: 1200000) else { throw HemiDeviceError.message("Native downloaded bytes differ", "test") }
        try store.remove(id: id); guard FileManager.default.fileExists(atPath: url.path) else { throw HemiDeviceError.message("Retained native file vanished", "test") }; store.release(id: id)
        print("PASS production native TLS/signature -> actual registered Host resource chunks -> native SHA-256 staging and presentation lifetime")
    }
}
