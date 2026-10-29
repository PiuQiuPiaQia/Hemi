import Foundation

final class CancellationCredentials: HemiCredentialStore {
    var values:[String:Data]=[:]
    func read(_ name:String)throws->Data? {values[name]}
    func write(_ name:String,_ data:Data?)throws {values[name]=data}
}
@main struct NativeCancellationIntegration {
    static func main() async throws {
        let folder=URL(fileURLWithPath:CommandLine.arguments[1]),client=HemiDeviceClient(store:CancellationCredentials())
        func record(_ name:String,_ value:Any)throws {try JSONSerialization.data(withJSONObject:value).write(to:folder.appendingPathComponent(name),options:.atomic)}
        func wait(_ name:String)async throws {for _ in 0..<300 {if FileManager.default.fileExists(atPath:folder.appendingPathComponent(name).path){return};try await Task.sleep(nanoseconds:20_000_000)};throw HemiDeviceError.message("Cancellation fixture timed out","test")}
        _=try await client.prepare(String(contentsOf:folder.appendingPathComponent("invite.json"),encoding:.utf8),name:"Cancellation fixture")
        try record("requested.json",try await client.pairRequest());try await wait("approved")
        _=try await client.pairStatus()
        let requestId=UUID().uuidString
        let slow=Task {try await client.request(method:"flow.snapshot",params:["id":"slow-read"],requestId:requestId)}
        try await wait("read-started")
        let start=Date();await client.cancelRequest(requestId)
        var cancelled=false
        do {_=try await slow.value} catch {cancelled=true}
        guard cancelled else {throw HemiDeviceError.message("A cancelled read succeeded","test")}
        let elapsed=Date().timeIntervalSince(start)*1000
        guard elapsed<1000 else {throw HemiDeviceError.message("Native cancellation waited for the old response","test")}
        let small=try await client.request(method:"snapshot",params:[:])
        let early=UUID().uuidString;await client.cancelRequest(early)
        do {_=try await client.request(method:"flow.snapshot",params:["id":"cancelled-before-start"],requestId:early);throw HemiDeviceError.message("A pre-cancelled request was sent","test")}
        catch let error as HemiDeviceError {guard error.code=="cancelled" else {throw error}}
        try record("result.json",["cancelled":true,"cancelMs":elapsed,"otherRequestSucceeded":small["ok"] as? Bool==true,"preCancelled":true])
    }
}
