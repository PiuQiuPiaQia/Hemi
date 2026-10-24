import Foundation
import Darwin
private final class CancellationStore: HemiCredentialStore {
    var values: [String:Data] = [:]
    func read(_ name: String) throws -> Data? { values[name] }
    func write(_ name: String, _ data: Data?) throws { values[name] = data }
}
@main struct NativeCancellationIntegration {
    static func main() async throws {
        let folder=URL(fileURLWithPath:CommandLine.arguments[1]), store=CancellationStore(), client=HemiDeviceClient(store:store)
        let qr=try String(contentsOf:folder.appendingPathComponent("invite.json"),encoding:.utf8)
        _=try await client.prepare(qr,name:"Cancellation test")
        let sending=Task {try await client.pairRequest()}
        var started=false
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath:folder.appendingPathComponent("request-started").path) {started=true;break}
            try await Task.sleep(nanoseconds:50_000_000)
        }
        guard started else {throw HemiDeviceError.message("Test TLS request did not start","test")}
        let start=Date()
        let cancelling=Task {try await client.pairStatus(cancel:true)}
        do {_=try await sending.value;throw HemiDeviceError.message("Blocked request unexpectedly completed","test")}
        catch let error as HemiDeviceError {guard error.code=="network"&&Date().timeIntervalSince(start)<3 else {throw error}}
        do {_=try await cancelling.value;throw HemiDeviceError.message("Unreachable cancellation falsely succeeded","test")}
        catch let error as HemiDeviceError {guard error.code=="network"&&Date().timeIntervalSince(start)<15 else {throw error}}
        guard try await client.restore()["pending"] != nil else {throw HemiDeviceError.message("Unknown cancellation lost identity","test")}
        try await client.forgetPairing()
        guard try await client.restore()["pending"] == nil else {throw HemiDeviceError.message("Explicit local exit did not clear pending identity","test")}
        print("PASS blocked native request interrupted; cancellation bounded; unknown identity retained until explicit local exit")
    }
}
