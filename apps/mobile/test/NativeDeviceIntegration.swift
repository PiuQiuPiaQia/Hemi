import Foundation
import CoreImage
import Vision

final class TestCredentialStore: HemiCredentialStore {
    var values: [String: Data] = [:]
    func read(_ key: String) throws -> Data? { values[key] }
    func write(_ key: String, _ value: Data?) throws { values[key] = value }
}

@main struct NativeDeviceIntegration {
    static func main() async throws {
        let args = CommandLine.arguments, folder = URL(fileURLWithPath: args[2])
        func record(_ name: String, _ value: Any) throws { try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]).write(to:folder.appendingPathComponent(name),options:.atomic) }
        try record("progress.json",["stage":"decoding QR"])
        let imageURL = URL(fileURLWithPath:args[1])
        var decoded: String?
        if let image = CIImage(contentsOf:imageURL),
           let detector = CIDetector(ofType:CIDetectorTypeQRCode,context:CIContext(options:[.useSoftwareRenderer:true]),options:[CIDetectorAccuracy:CIDetectorAccuracyHigh]) {
            decoded = (detector.features(in:image).first as? CIQRCodeFeature)?.messageString
        }
        if decoded == nil {
            // Core Image can miss dense codes on macOS CI; still decode actual PC pixels.
            let request = VNDetectBarcodesRequest(); request.symbologies = [.qr]
            request.usesCPUOnly = true // Verification hosts may not have a usable ANE model.
            try VNImageRequestHandler(url:imageURL).perform([request])
            decoded = request.results?.first?.payloadStringValue
        }
        guard let qr = decoded else { throw HemiDeviceError.message("Actual PC QR could not be decoded", "test") }
        let memory = TestCredentialStore(), client = HemiDeviceClient(store:memory)
        try record("progress.json",["stage":"preparing identity"])
        let target = try await client.prepare(qr,name:args[3])
        try record("progress.json",["stage":"requesting via native TLS"])
        let result = try await client.pairRequest(); try record("request.json",result)
        var approved = false
        for _ in 0..<50 {
            if FileManager.default.fileExists(atPath:folder.appendingPathComponent("approved").path) { approved = true; break }
            try await Task.sleep(nanoseconds:500_000_000)
        }
        guard approved else { throw HemiDeviceError.message("PC approval timeout", "test") }
        async let firstStatus = client.pairStatus()
        async let secondStatus = client.pairStatus()
        let statuses = try await [firstStatus, secondStatus]
        guard statuses.allSatisfy({$0["status"] as? String == "approved"}) else { throw HemiDeviceError.message("Concurrent approval status lost", "test") }
        let snapshot = try await client.request(method:"snapshot",params:[:])
        guard let value = snapshot["result"] as? [String: Any], let sessions = value["sessions"] as? [[String: Any]], sessions.contains(where:{$0["title"] as? String == "跨端真实会话"}) else { throw HemiDeviceError.message("Actual Host conversation was not returned", "test") }
        let reloaded = HemiDeviceClient(store:memory)
        guard try await reloaded.restore()["active"] != nil else { throw HemiDeviceError.message("Stored identity not restored", "test") }
        _ = try await reloaded.request(method:"snapshot",params:[:])
        let created = try await client.request(method:"session.create",params:["requestId":UUID().uuidString])
        guard let createdValue = created["result"] as? [String: Any], let id = createdValue["id"] as? String else { throw HemiDeviceError.message("Real create failed", "test") }
        let sent = try await client.request(method:"flow.command",params:["id":id,"requestId":UUID().uuidString,"command":["type":"send","input":["inputId":UUID().uuidString,"text":"原生签名通道发送","inputSource":"text","attachmentIds":[]]]])
        guard (sent["result"] as? [String: Any])?["ok"] as? Bool == true else { throw HemiDeviceError.message("Real send failed", "test") }
        let flow = try await client.request(method:"flow.snapshot",params:["id":id])
        guard let timeline = (flow["result"] as? [String: Any])?["timeline"] as? [[String: Any]], timeline.contains(where:{$0["text"] as? String == "原生签名通道发送"}) else { throw HemiDeviceError.message("Real sent message missing", "test") }
        let endpoint = URL(string:target["endpoint"] as! String)!
        var wrongPinRejected = false
        do { _ = try await HemiPinnedSession(endpoint:endpoint,pin:String(repeating:"A",count:43)).post("v1/challenge",[:]) } catch { wrongPinRejected = true }
        guard wrongPinRejected else { throw HemiDeviceError.message("Wrong TLS pin accepted", "test") }
        try record("ready.json",["readActualConversation":true,"restoredIdentity":true,"createdAndSent":true,"wrongPinRejected":true,"concurrentApprovalStatus":true])
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath:folder.appendingPathComponent("revoked").path) { break }
            try await Task.sleep(nanoseconds:500_000_000)
        }
        var revoked = false
        do { _ = try await client.request(method:"snapshot",params:[:]) }
        catch let error as HemiDeviceError { revoked = error.code == "permission" }
        guard revoked else { throw HemiDeviceError.message("Revoked device accessed Host", "test") }
        try record("done.json",["nativeTLS":true,"nativeES256":true,"actualQRCodeDecoded":true,"revocationRejected":true])
    }
}
