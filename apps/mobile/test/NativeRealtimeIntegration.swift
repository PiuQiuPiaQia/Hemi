import Foundation

final class RealtimeCredentials: HemiCredentialStore {
    var values: [String:Data] = [:]
    func read(_ name: String) throws -> Data? {values[name]}
    func write(_ name: String, _ data: Data?) throws {values[name]=data}
}
final class RealtimeFrames: @unchecked Sendable {
    let lock=NSLock(), folder:URL
    var frames:[[String:Any]]=[]
    init(_ folder:URL) {self.folder=folder}
    func receive(_ frame:[String:Any]) {
        lock.lock();defer{lock.unlock()};frames.append(frame)
        try? JSONSerialization.data(withJSONObject:frames,options:[.sortedKeys]).write(to:folder.appendingPathComponent("frames.json"),options:.atomic)
    }
}
@main struct NativeRealtimeIntegration {
    static func main() async throws {
        let folder=URL(fileURLWithPath:CommandLine.arguments[1]), frames=RealtimeFrames(folder),client=HemiDeviceClient(store:RealtimeCredentials())
        func record(_ name:String,_ value:Any) throws {try JSONSerialization.data(withJSONObject:value).write(to:folder.appendingPathComponent(name),options:.atomic)}
        func gate(_ name:String) async throws {for _ in 0..<400 {if FileManager.default.fileExists(atPath:folder.appendingPathComponent(name).path){return};try await Task.sleep(nanoseconds:100_000_000)};throw HemiDeviceError.message("Native gate timed out: \(name)","test")}
        let qr=try String(contentsOf:folder.appendingPathComponent("invite.json"),encoding:.utf8)
        _=try await client.prepare(qr,name:"Realtime native fixture")
        try record("request.json",try await client.pairRequest());try await gate("approved")
        _=try await client.pairStatus()
        let options=try JSONSerialization.jsonObject(with:Data(contentsOf:folder.appendingPathComponent("options.json"))) as! [String:Any]
        try await client.openEvents(streamId:"native",options:options,receive:{frames.receive($0)},disconnected:{frames.receive(["disconnected":true])})
        try await gate("send")
        let id=options["id"] as! String
        _=try await client.request(method:"session.control",params:["id":id,"action":"takeover"])
        try record("sent.json",try await client.request(method:"flow.command",params:["id":id,"requestId":"native-queue-operation-\(id)","command":["type":"send","input":["inputId":"native-queue-\(id)","text":"原生手机排队消息"]]]))
        try await gate("reconnect")
        await client.closeEvents(streamId:"native");try record("disconnected.json",["closed":true]);try await gate("resume")
        try await client.openEvents(streamId:"native-reconnect",options:options,receive:{frames.receive($0)},disconnected:{frames.receive(["disconnected":true])})
        try await gate("finish")
        await client.closeEvents(streamId:"native-reconnect")
        try record("done.json",["nativeWSS":true])
    }
}
