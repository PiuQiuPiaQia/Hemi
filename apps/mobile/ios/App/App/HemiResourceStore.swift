import Foundation
import CryptoKit

/** Private, bounded staging. Native presentations retain a file until their own dismissal. */
final class HemiResourceStore {
    private struct Entry { var url: URL; var size: Int; var sha256: String; var received = 0; var ready = false; var retained = false }
    private let root: URL
    private var entries: [String: Entry] = [:]
    private let lock = NSLock()
    init(root: URL? = nil) {
        self.root = root ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("HemiResourceFiles", isDirectory: true)
        // Completed previews never persist across process restarts.
        try? FileManager.default.removeItem(at: self.root)
    }
    func begin(name: String, size: Int, sha256: String) throws -> String {
        lock.lock(); defer { lock.unlock() }
        let safeName = (name as NSString).lastPathComponent
        guard size >= 0, size <= 20 * 1024 * 1024, !safeName.isEmpty, safeName != ".", safeName != "..", safeName.count <= 180, !safeName.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }), sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw HemiDeviceError.message("文件信息无效或超过 20MB。", "invalid") }
        guard entries.count < 8 else { throw HemiDeviceError.message("打开的文件过多，请先关闭预览。", "busy") }
        let id = UUID().uuidString.lowercased(), dir = root.appendingPathComponent(id, isDirectory: true), url = dir.appendingPathComponent(safeName)
        #if os(iOS)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        #else
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        #endif
        guard FileManager.default.createFile(atPath: url.path, contents: Data(), attributes: [.posixPermissions: 0o600]) else { throw HemiDeviceError.message("无法创建本机文件，请检查存储空间。", "failed") }
        entries[id] = Entry(url: url, size: size, sha256: sha256); return id
    }
    func append(id: String, offset: Int, base64: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard var entry = entries[id], !entry.ready, offset == entry.received, base64.utf8.count <= 349528, let data = Data(base64Encoded: base64), !data.isEmpty, data.count <= 256 * 1024, data.base64EncodedString() == base64, offset + data.count <= entry.size else { throw HemiDeviceError.message("文件分片或进度无效。", "invalid") }
        let handle = try FileHandle(forWritingTo: entry.url); defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset)); try handle.write(contentsOf: data)
        entry.received += data.count; entries[id] = entry
    }
    func finish(id: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard var entry = entries[id], entry.received == entry.size else { throw HemiDeviceError.message("文件尚未下载完整。", "invalid") }
        let handle = try FileHandle(forReadingFrom: entry.url); defer { try? handle.close() }; var hash = SHA256(), count = 0
        while let data = try handle.read(upToCount: 256 * 1024), !data.isEmpty { hash.update(data: data); count += data.count }
        guard count == entry.size, hash.finalize().map({ String(format: "%02x", $0) }).joined() == entry.sha256 else { throw HemiDeviceError.message("文件完整性校验失败，请重试。", "invalid") }
        entry.ready = true; entries[id] = entry
    }
    func retain(id: String) throws -> URL {
        lock.lock(); defer { lock.unlock() }
        guard var entry = entries[id], entry.ready, !entry.retained else { throw HemiDeviceError.message("文件未就绪或正在打开。", "missing") }
        entry.retained = true; entries[id] = entry; return entry.url
    }
    func remove(id: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard let entry = entries[id], !entry.retained else { return }
        try FileManager.default.removeItem(at: entry.url.deletingLastPathComponent()); entries.removeValue(forKey: id)
    }
    func release(id: String) {
        lock.lock(); defer { lock.unlock() }
        guard let entry = entries.removeValue(forKey: id) else { return }
        try? FileManager.default.removeItem(at: entry.url.deletingLastPathComponent())
    }
}
