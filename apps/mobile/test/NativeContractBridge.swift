import Foundation
final class ContractCredentials:HemiCredentialStore {var values:[String:Data]=[:];func read(_ name:String)throws->Data?{values[name]};func write(_ name:String,_ data:Data?)throws{values[name]=data}}
final class ContractOutput:@unchecked Sendable {let lock=NSLock();func send(_ value:[String:Any]){lock.lock();defer{lock.unlock()};if let data=try? JSONSerialization.data(withJSONObject:value),var line=String(data:data,encoding:.utf8){line+="\n";FileHandle.standardOutput.write(Data(line.utf8))}}}
@main struct NativeContractBridge {
 static func main() async throws {
  let folder=URL(fileURLWithPath:CommandLine.arguments[1]),client=HemiDeviceClient(store:ContractCredentials()),output=ContractOutput()
  _=try await client.prepare(String(contentsOf:folder.appendingPathComponent("invite.json"),encoding:.utf8),name:"SDK contract fixture")
  _=try await client.pairRequest();try Data("{}".utf8).write(to:folder.appendingPathComponent("requested.json"))
  while !FileManager.default.fileExists(atPath:folder.appendingPathComponent("approved").path){try await Task.sleep(nanoseconds:50_000_000)}
  _=try await client.pairStatus();output.send(["ready":true])
  await Task.detached {
   while let line=readLine(){guard let data=line.data(using:.utf8),let message=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let key=message["key"] as? String else {continue}
    Task {
     do {
      let method=message["method"] as? String ?? "",options=message["options"] as? [String:Any] ?? [:]
      var value:[String:Any]=[:]
      if method=="request" {value=try await client.request(method:options["method"] as! String,params:options["params"] as? [String:Any] ?? [:],requestId:options["requestId"] as? String)}
      else if method=="cancelRequest" {await client.cancelRequest(options["requestId"] as? String ?? "")}
      else if method=="openEvents" {let id=options["streamId"] as! String;try await client.openEvents(streamId:id,options:options["options"] as? [String:Any] ?? [:],receive:{output.send(["streamId":id,"frame":$0])},disconnected:{output.send(["streamId":id,"disconnected":true])})}
      else if method=="closeEvents" {await client.closeEvents(streamId:options["streamId"] as! String)}
      output.send(["key":key,"ok":true,"value":value])
     }catch {output.send(["key":key,"ok":false,"message":error.localizedDescription])}
    }
   }
  }.value
 }
}
