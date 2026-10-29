import Foundation

@main struct NativeSlowResponseIntegration {
    static func main() async throws {
        let endpoint=URL(string:CommandLine.arguments[1])!,pin=CommandLine.arguments[2]
        let start=Date()
        let value=try await HemiPinnedSession(endpoint:endpoint,pin:pin).post("v1/rpc",["scenario":"slow"])
        guard let result=value["result"] as? [String:Any],let text=result["text"] as? String,text.utf8.count==2700000,Date().timeIntervalSince(start)>12 else {throw HemiDeviceError.message("Slow compressed response was not restored","test")}
        for scenario in ["oversize","invalid"] {
            do {_=try await HemiPinnedSession(endpoint:endpoint,pin:pin).post("v1/rpc",["scenario":scenario]);throw HemiDeviceError.message("Unsafe compressed response was accepted","test")}
            catch let error as HemiDeviceError {guard error.code=="unknown" else {throw error}}
        }
        print("PASS slow gzip response exceeds 12 seconds without losing progress; decoded size and malformed gzip are bounded")
    }
}
