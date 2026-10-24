import Foundation
import CryptoKit
import Security
import Network

enum HemiDeviceError: LocalizedError {
    case message(String, String)
    var errorDescription: String? { if case let .message(text, _) = self { return text }; return nil }
    var code: String { if case let .message(_, code) = self { return code }; return "failed" }
}

private func encoded(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
private func digest(_ data: Data) -> String { encoded(Data(SHA256.hash(data: data))) }
private func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) }

protocol HemiCredentialStore {
    func read(_ name: String) throws -> Data?
    func write(_ name: String, _ data: Data?) throws
}

struct HemiKeychainStore: HemiCredentialStore {
    private func query(_ name: String) -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "ai.hemi.mobile.bot", kSecAttrAccount as String: name] }
    func read(_ name: String) throws -> Data? {
        var q = query(name); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw HemiDeviceError.message("无法读取设备身份，请解锁手机后重试。", "storage") }
        return item as? Data
    }
    func write(_ name: String, _ data: Data?) throws {
        let q = query(name)
        guard let data = data else { let status = SecItemDelete(q as CFDictionary); guard status == errSecSuccess || status == errSecItemNotFound else { throw HemiDeviceError.message("无法清除本机连接身份。", "storage") }; return }
        let changes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(q as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound { var next = q; changes.forEach { next[$0.key] = $0.value }; guard SecItemAdd(next as CFDictionary, nil) == errSecSuccess else { throw HemiDeviceError.message("无法安全保存设备身份。", "storage") } }
        else if status != errSecSuccess { throw HemiDeviceError.message("无法安全保存设备身份。", "storage") }
    }
}

struct HemiDeviceCredential: Codable {
    var endpoint: String
    var botInstanceId: String
    var certificatePin: String
    var privateKey: Data
    var inviteId: String
    var requestId: String
    var ticket: String
    var expiresAt: Double
    var attempted: Bool
    var name: String
    var preview: [String: Any] { ["endpoint": endpoint, "botInstanceId": botInstanceId, "expiresAt": expiresAt, "name": name] }
}

// One narrowly framed HTTP/1.1 exchange over native TLS. The Bot always emits
// Content-Length; chunked framing, redirects, cookies and connection reuse are rejected.
private final class HemiTLSVerification { var error: String? }

private final class HemiTLSExchange: @unchecked Sendable {
    let connection: NWConnection
    let queue = DispatchQueue(label:"ai.hemi.mobile.device-tls")
    private var completion: ((Result<Data,Error>)->Void)?
    private var deadline: DispatchWorkItem?
    private var bytes = Data()
    private var bodyOffset: Int?
    private var bodyLength = 0
    private let verification: HemiTLSVerification
    private var sent = false
    init(endpoint: URL, pin: String) {
        let options = NWProtocolTLS.Options(), host = endpoint.host!.trimmingCharacters(in:CharacterSet(charactersIn:"[]"))
        let verification=HemiTLSVerification();self.verification=verification
        sec_protocol_options_set_min_tls_protocol_version(options.securityProtocolOptions,.TLSv12)
        sec_protocol_options_add_tls_application_protocol(options.securityProtocolOptions,"http/1.1")
        sec_protocol_options_set_tls_server_name(options.securityProtocolOptions,host)
        sec_protocol_options_set_verify_block(options.securityProtocolOptions,{ _, value, complete in
            let trust = sec_trust_copy_ref(value).takeRetainedValue()
            guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let certificate = chain.first else {verification.error="Bot 未提供可核对的 TLS 证书。";complete(false);return}
            guard digest(SecCertificateCopyData(certificate) as Data)==pin else {verification.error="Bot 证书指纹与配对码不一致，请核对服务器。";complete(false);return}
            SecTrustSetPolicies(trust,SecPolicyCreateSSL(true,host as CFString))
            SecTrustSetAnchorCertificates(trust,[certificate] as CFArray)
            SecTrustSetAnchorCertificatesOnly(trust,true)
            SecTrustSetNetworkFetchAllowed(trust,false)
            guard SecTrustEvaluateWithError(trust,nil) else {verification.error="Bot 证书无效、已过期或与地址不匹配，请在 PC 检查设备连接设置。";complete(false);return}
            complete(true)
        },queue)
        connection = NWConnection(host:NWEndpoint.Host(host),port:NWEndpoint.Port(rawValue:UInt16(endpoint.port ?? 443))!,using:NWParameters(tls:options,tcp:NWProtocolTCP.Options()))
    }
    func start(request: Data, completion: @escaping (Result<Data,Error>)->Void) {
        queue.async {
            self.completion=completion
            let timeout=DispatchWorkItem {self.finish(.failure(HemiDeviceError.message("Bot 连接超时，结果待核对。请检查网络与设备端口。","network")))}
            self.deadline=timeout;self.queue.asyncAfter(deadline:.now()+12,execute:timeout)
            self.connection.stateUpdateHandler={ state in
                switch state {
                case .ready:
                    guard !self.sent else {return};self.sent=true
                    self.connection.send(content:request,completion:.contentProcessed { error in
                        if let error=error {self.networkFailure(error)} else {self.receive()}
                    })
                case .failed(let error): self.networkFailure(error)
                default: break
                }
            }
            self.connection.start(queue:self.queue)
        }
    }
    func cancel() {queue.async {self.finish(.failure(HemiDeviceError.message("已停止本次等待，配对结果仍需核对。","network")))}}
    private func networkFailure(_ error: NWError) {
        if let reason=verification.error {finish(.failure(HemiDeviceError.message(reason,"tls")));return}
        if case .tls = error {finish(.failure(HemiDeviceError.message("无法完成 Bot 的安全连接，请核对服务器证书与 TLS 配置。","tls")));return}
        finish(.failure(HemiDeviceError.message("Bot 连接未完成，结果待核对。请检查网络与设备端口。","network")))
    }
    private func finish(_ result: Result<Data,Error>) {
        guard let callback=completion else {return}
        completion=nil;deadline?.cancel();deadline=nil
        connection.stateUpdateHandler=nil;connection.cancel();callback(result)
    }
    private func receive() {
        guard completion != nil else {return}
        connection.receive(minimumIncompleteLength:1,maximumLength:65536) { data, _, complete, error in
            if let error=error {self.networkFailure(error);return}
            if let data=data {self.bytes.append(data)}
            do {
                if self.bodyOffset==nil {
                    if let split=self.bytes.range(of:Data([13,10,13,10])) {
                        guard split.upperBound<=16384,let text=String(data:self.bytes[..<split.lowerBound],encoding:.utf8) else {throw HemiDeviceError.message("Bot 响应头无效。","unknown")}
                        let lines=text.components(separatedBy:"\r\n"), status=lines[0].split(separator:" ")
                        guard status.count>=2,["HTTP/1.1","HTTP/1.0"].contains(String(status[0])),let code=Int(status[1]),(200..<300).contains(code)||(400..<600).contains(code) else {throw HemiDeviceError.message("Bot 返回了无效状态或重定向。","unknown")}
                        var length: Int?
                        for line in lines.dropFirst() {
                            guard let colon=line.firstIndex(of:":") else {throw HemiDeviceError.message("Bot 响应头格式无效。","unknown")}
                            let name=line[..<colon].lowercased(),value=line[line.index(after:colon)...].trimmingCharacters(in:.whitespaces)
                            if name=="transfer-encoding" {throw HemiDeviceError.message("Bot 响应使用了不支持的分块协议，请更新云端组件。","unknown")}
                            if name=="content-length" {
                                guard length==nil,!value.isEmpty,value.allSatisfy({$0.isASCII&&$0.isNumber}),let count=Int(value),(0...40*1024*1024).contains(count) else {throw HemiDeviceError.message("Bot 响应长度无效。","unknown")}
                                length=count
                            }
                        }
                        guard let length=length else {throw HemiDeviceError.message("Bot 响应缺少长度，请更新云端组件。","unknown")}
                        self.bodyOffset=split.upperBound;self.bodyLength=length
                    } else if self.bytes.count>16384 {throw HemiDeviceError.message("Bot 响应头过长。","unknown")}
                }
                if let offset=self.bodyOffset {
                    let expected=offset+self.bodyLength
                    guard self.bytes.count<=expected else {throw HemiDeviceError.message("Bot 响应长度不匹配。","unknown")}
                    if self.bytes.count==expected {self.finish(.success(Data(self.bytes[offset..<expected])));return}
                }
                if complete {throw HemiDeviceError.message("Bot 回执未完整返回，结果待核对。","network")}
                self.receive()
            } catch {self.finish(.failure(error))}
        }
    }
}

final class HemiPinnedSession: @unchecked Sendable {
    let endpoint: URL
    let pin: String
    private let lock=NSLock()
    private var current: HemiTLSExchange?
    private var cancelled=false
    init(endpoint: URL,pin: String) {self.endpoint=endpoint;self.pin=pin}
    func cancel() {lock.lock();cancelled=true;let active=current;lock.unlock();active?.cancel()}
    private func attach(_ exchange: HemiTLSExchange?) -> Bool {lock.lock();defer{lock.unlock()};if cancelled&&exchange != nil{return false};current=exchange;return true}
    func post(_ route: String,_ body: [String:Any]) async throws -> [String:Any] {
        guard endpoint.scheme=="https",endpoint.host != nil,let port=endpoint.port.map({UInt16(exactly:$0)}) ?? 443,port>0 else {throw HemiDeviceError.message("Bot 地址或端口无效。","invalid")}
        let payload=try json(body),exchange=HemiTLSExchange(endpoint:endpoint,pin:pin)
        guard attach(exchange) else {throw HemiDeviceError.message("已停止本次等待，配对结果仍需核对。","network")}
        defer {_ = attach(nil)}
        let host=endpoint.host!.trimmingCharacters(in:CharacterSet(charactersIn:"[]")), authority=(host.contains(":") ? "[\(host)]" : host)+":\(endpoint.port ?? 443)"
        var request=Data("POST /\(route) HTTP/1.1\r\nHost: \(authority)\r\nContent-Type: application/json\r\nContent-Length: \(payload.count)\r\nConnection: close\r\n\r\n".utf8);request.append(payload)
        #if DEBUG
        print("HemiBot: native TLS POST started: \(route)")
        #endif
        let data: Data=try await withCheckedThrowingContinuation {continuation in exchange.start(request:request){continuation.resume(with:$0)}}
        guard let envelope=try JSONSerialization.jsonObject(with:data) as? [String:Any],envelope["ok"] is Bool else {throw HemiDeviceError.message("Bot 未返回有效回执。","unknown")}
        if envelope["ok"] as? Bool==false {throw HemiDeviceError.message(envelope["message"] as? String ?? "Bot 拒绝了请求。",envelope["code"] as? String ?? "failed")}
        return envelope
    }
}

actor HemiDeviceClient {
    let store: HemiCredentialStore
    private var pairingSessions: [UUID:HemiPinnedSession] = [:]
    init(store: HemiCredentialStore = HemiKeychainStore()) { self.store = store }
    private func load(_ key: String) throws -> HemiDeviceCredential? { try store.read(key).map { try JSONDecoder().decode(HemiDeviceCredential.self, from: $0) } }
    private func save(_ key: String, _ value: HemiDeviceCredential?) throws { try store.write(key, try value.map { try JSONEncoder().encode($0) }) }
    func restore() throws -> [String: Any] {
        var result: [String: Any] = [:]
        if let active = try load("active") { result["active"] = active.preview }
        if let pending = try load("pending") { result["pending"] = pending.preview }
        return result
    }
    func prepare(_ qr: String, name: String) throws -> [String: Any] {
        guard qr.utf8.count <= 2048, let data = qr.data(using: .utf8), let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["type"] as? String == "hemi-bot-pair", value["version"] as? Int == 1,
              let endpoint = value["endpoint"] as? String, let url = URL(string: endpoint), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty, url.port == nil || (1...65535).contains(url.port!),
              let instance = value["botInstanceId"] as? String, UUID(uuidString: instance) != nil,
              let invite = value["inviteId"] as? String, UUID(uuidString: invite) != nil,
              let ticket = value["requestTicket"] as? String, ticket.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let pin = value["certificatePin"] as? String, pin.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let expires = value["expiresAt"] as? Double, expires > Date().timeIntervalSince1970 * 1000, expires <= Date().timeIntervalSince1970 * 1000 + 150000 else { throw HemiDeviceError.message("这不是有效的 Hemi 配对码，或邀请已过期。", "invalid") }
        guard try load("pending") == nil else { throw HemiDeviceError.message("请先处理上次未完成的配对。", "conflict") }
        let credential = HemiDeviceCredential(endpoint: endpoint, botInstanceId: instance, certificatePin: pin, privateKey: P256.Signing.PrivateKey().rawRepresentation, inviteId: invite, requestId: UUID().uuidString, ticket: ticket, expiresAt: expires, attempted: false, name: String(name.prefix(60)))
        try save("pending", credential); return credential.preview
    }
    private func signed(_ route: String, body: [String: Any], credential: HemiDeviceCredential) async throws -> [String: Any] {
        guard let url = URL(string: credential.endpoint) else { throw HemiDeviceError.message("Bot 地址无效。", "invalid") }
        let session = HemiPinnedSession(endpoint: url, pin: credential.certificatePin)
        let connection = UUID()
        if route != "v1/rpc" { pairingSessions[connection] = session }
        defer { pairingSessions.removeValue(forKey: connection) }
        let challenge = try await session.post("v1/challenge", [:])
        guard let result = challenge["result"] as? [String: Any], let nonce = result["nonce"] as? String, result["instanceId"] as? String == credential.botInstanceId else { throw HemiDeviceError.message("Bot 身份已变化，请重新配对。", "conflict") }
        let key = try P256.Signing.PrivateKey(rawRepresentation: credential.privateKey), publicKey = key.publicKey.x963Representation
        let jwk = ["kty": "EC", "crv": "P-256", "x": encoded(publicKey.subdata(in: 1..<33)), "y": encoded(publicKey.subdata(in: 33..<65))]
        let payload = try json(body)
        let header = try json(["alg":"ES256", "typ":"hemi-device+jwt", "jwk":jwk] as [String: Any])
        let claims = try json(["iss":"hemi-device-v1", "sub":digest(try json(jwk)), "aud":"\(credential.botInstanceId):/\(route)", "iat":Int(Date().timeIntervalSince1970), "jti":UUID().uuidString, "nonce":nonce, "bodyHash":digest(payload)] as [String: Any])
        let input = "\(encoded(header)).\(encoded(claims))"
        let signature = try key.signature(for: Data(input.utf8)).rawRepresentation
        return try await session.post(route, ["payload":String(decoding:payload,as:UTF8.self), "proof":"\(input).\(encoded(signature))"])
    }
    func pairRequest() async throws -> [String: Any] {
        guard var pending = try load("pending") else { throw HemiDeviceError.message("请先扫描配对码。", "missing") }
        pending.attempted = true; try save("pending", pending)
        let result = try await signed("v1/pair/request", body:["inviteId":pending.inviteId,"ticket":pending.ticket,"requestId":pending.requestId,"name":pending.name], credential:pending)
        return result["result"] as? [String: Any] ?? [:]
    }
    func pairStatus(cancel: Bool = false) async throws -> [String: Any] {
        if cancel { for connection in pairingSessions.values { connection.cancel() } }
        guard var pending = try load("pending") else { throw HemiDeviceError.message("没有待处理的配对。", "missing") }
        if !pending.attempted {
            if cancel { try save("pending", nil); return ["status":"cancelled"] }
            return ["status":"preview", "target":pending.preview]
        }
        let envelope = try await signed(cancel ? "v1/pair/cancel" : "v1/pair/status", body:["inviteId":pending.inviteId,"requestId":pending.requestId,"ticket":cancel ? pending.ticket : ""], credential:pending)
        let result = envelope["result"] as? [String: Any] ?? [:]
        if let current = try load("pending") {
            guard current.requestId == pending.requestId else { throw HemiDeviceError.message("配对申请已变化。", "conflict") }
        } else {
            // A concurrent status/cancel call may already have saved this outcome.
            if try load("active")?.requestId == pending.requestId { return ["status":"approved"] }
            if ["cancelled","rejected","expired","revoked"].contains(result["status"] as? String ?? "") { return result }
            throw HemiDeviceError.message("配对申请已变化，请核对连接结果。", "conflict")
        }
        if result["status"] as? String == "approved" {
            pending.ticket = ""; try save("active", pending); try save("pending", nil)
        } else if ["cancelled","rejected","expired","revoked"].contains(result["status"] as? String ?? "") { try save("pending", nil) }
        return result
    }
    func request(method: String, params: [String: Any]) async throws -> [String: Any] {
        guard let active = try load("active") else { throw HemiDeviceError.message("请先连接 Bot。", "missing") }
        return try await signed("v1/rpc", body:["method":method,"params":params], credential:active)
    }
    func forget() throws { try save("active", nil) }
    func forgetPairing() throws { for connection in pairingSessions.values { connection.cancel() }; try save("pending", nil) }
}
