import Capacitor
import UIKit
import AVFoundation
import UniformTypeIdentifiers
import PhotosUI
import CryptoKit
import QuickLook

class HemiBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() { bridge?.registerPluginInstance(HemiBotPlugin()) }
}

@objc(HemiBotPlugin)
public class HemiBotPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate, PHPickerViewControllerDelegate, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    public let identifier = "HemiBotPlugin"
    public let jsName = "HemiBot"
    public let pluginMethods: [CAPPluginMethod] = ["scan", "prepare", "pairRequest", "pairStatus", "cancelPairing", "forgetPairing", "restore", "request", "cancelRequest", "openEvents", "closeEvents", "forget", "pickFiles", "readPickedFile", "removePickedFile", "beginResource", "appendResource", "finishResource", "removeResource", "presentResource"].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    private let resources = HemiResourceStore()
    private var resourcePresentation: (id: String, url: URL)?
    private var resourceExport: UIDocumentPickerViewController?
    private let client = HemiDeviceClient()
    private var scanner: HemiScannerController?
    private var pickerCall: CAPPluginCall?
    private var pickerLimit = 3
    private let fileQueue = DispatchQueue(label: "ai.hemi.mobile.picked-files")
    private var pickedRoot: URL { FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("HemiPickedFiles", isDirectory: true) }
    private func pickedDirectory(_ id: String) throws -> URL {
        guard UUID(uuidString: id) != nil else { throw HemiDeviceError.message("文件身份无效。", "invalid") }
        return pickedRoot.appendingPathComponent(id, isDirectory: true)
    }
    private func stageFile(_ url: URL) throws -> [String: Any] {
        let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
        let id = UUID().uuidString.lowercased(), dir = try pickedDirectory(id)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        do {
            let file = dir.appendingPathComponent("content")
            var name = url.lastPathComponent, error: NSError?, copyError: Error?
            NSFileCoordinator().coordinate(readingItemAt: url, options: .withoutChanges, error: &error) { source in
                do {
                    let info = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                    guard info.isRegularFile == true, let size = info.fileSize, size > 0, size <= 20 * 1024 * 1024 else { throw HemiDeviceError.message("文件为空或超过 20MB，请减少文件大小。", "invalid") }
                    try FileManager.default.copyItem(at: source, to: file)
                } catch { copyError = error }
            }
            if let error = error { throw error }; if let error = copyError { throw error }
            if ["heic", "heif"].contains(url.pathExtension.lowercased()) {
                guard let image = UIImage(contentsOfFile: file.path), let jpeg = image.jpegData(compressionQuality: 0.9) else { throw HemiDeviceError.message("无法读取这张照片，请换一张重试。", "invalid") }
                try jpeg.write(to: file, options: .atomic); name = url.deletingPathExtension().lastPathComponent + ".jpg"
            }
            let image = ["jpg","jpeg","png","webp","gif"].contains((name as NSString).pathExtension.lowercased())
            let supported = image || ["txt","md","markdown","pdf","docx","xlsx","pptx"].contains((name as NSString).pathExtension.lowercased())
            let size = (try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue ?? 0
            guard supported && size > 0 && size <= (image ? 10 : 20) * 1024 * 1024 else { throw HemiDeviceError.message("支持图片（10MB 内）、文本和 PDF／Word／Excel／PPT（20MB 内）。", "invalid") }
            let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
            var hash = SHA256()
            while let data = try handle.read(upToCount: 256 * 1024), !data.isEmpty { hash.update(data: data) }
            let metadata: [String: Any] = ["id": id, "name": name, "size": size, "kind": image ? "image" : "text", "sha256": hash.finalize().map { String(format: "%02x", $0) }.joined()]
            try JSONSerialization.data(withJSONObject: metadata).write(to: dir.appendingPathComponent("metadata.json"), options: .atomic)
            return metadata
        } catch { try? FileManager.default.removeItem(at: dir); throw error }
    }
    @objc func pickFiles(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.pickerCall == nil, self.scanner == nil, let presenter = self.bridge?.viewController else { call.reject("文件选择器正在使用。", "busy"); return }
            self.pickerCall = call; self.pickerLimit = min(3, max(1, call.getInt("limit") ?? 3))
            if call.getString("kind") == "photos" {
                var config = PHPickerConfiguration(); config.filter = .images; config.selectionLimit = self.pickerLimit; config.preferredAssetRepresentationMode = .current
                let picker = PHPickerViewController(configuration: config); picker.delegate = self; presenter.present(picker, animated: true)
            } else {
                let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: true)
                picker.allowsMultipleSelection = self.pickerLimit > 1; picker.delegate = self; presenter.present(picker, animated: true)
            }
        }
    }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        if controller === resourceExport { finishResourcePresentation() } else { finishPicking([], nil) }
    }
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        if controller === resourceExport { finishResourcePresentation(); return }
        guard urls.count <= pickerLimit else { finishPicking([], HemiDeviceError.message("每条消息最多 3 个附件，请减少选择数量。", "invalid")); return }
        fileQueue.async {
            var files: [[String: Any]] = []
            do { for url in urls { files.append(try self.stageFile(url)) }; self.finishPicking(files, nil) }
            catch { for file in files { if let id = file["id"] as? String, let dir = try? self.pickedDirectory(id) { try? FileManager.default.removeItem(at: dir) } }; self.finishPicking([], error) }
        }
    }
    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard !results.isEmpty else { finishPicking([], nil); return }
        let group = DispatchGroup(), lock = NSLock(); var files: [Int: [String: Any]] = [:], failure: Error?
        for (index, result) in results.enumerated() {
            group.enter()
            let type = result.itemProvider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) ?? UTType.image.identifier
            result.itemProvider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                defer { group.leave() }
                do {
                    guard let url = url else { throw error ?? HemiDeviceError.message("照片读取失败，请重试。", "failed") }
                    let file = try self.stageFile(url); lock.lock(); files[index] = file; lock.unlock()
                } catch { lock.lock(); failure = error; lock.unlock() }
            }
        }
        group.notify(queue: fileQueue) {
            if failure != nil { for file in files.values { if let id = file["id"] as? String, let dir = try? self.pickedDirectory(id) { try? FileManager.default.removeItem(at: dir) } } }
            self.finishPicking(failure == nil ? files.sorted(by: { $0.key < $1.key }).map { $0.value } : [], failure)
        }
    }
    private func finishPicking(_ files: [[String: Any]], _ error: Error?) {
        DispatchQueue.main.async {
            guard let call = self.pickerCall else { return }; self.pickerCall = nil
            if let error = error as? HemiDeviceError { call.reject(error.localizedDescription, error.code) }
            else if error != nil { call.reject("无法读取所选文件，请确认文件已下载到设备后重试。", "failed") }
            else { call.resolve(["files": files]) }
        }
    }
    @objc func readPickedFile(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let offset = call.getInt("offset"), let length = call.getInt("length"), offset >= 0, length > 0, length <= 256 * 1024 else { call.reject("文件读取参数无效。", "invalid"); return }
        fileQueue.async {
            do { let file = try self.pickedDirectory(id).appendingPathComponent("content"), handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }; try handle.seek(toOffset: UInt64(offset)); let data = try handle.read(upToCount: length) ?? Data(); call.resolve(["base64": data.base64EncodedString(), "size": data.count]) }
            catch { call.reject("本机暂存文件不可读，请重新选择。", "missing") }
        }
    }
    @objc func removePickedFile(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("缺少文件身份。", "invalid"); return }
        fileQueue.async { do { let dir = try self.pickedDirectory(id); if FileManager.default.fileExists(atPath: dir.path) { try FileManager.default.removeItem(at: dir) }; call.resolve() } catch { call.reject("无法清理本机文件。", "failed") } }
    }
    private func resourceWork(_ call: CAPPluginCall, action: @escaping () throws -> [String: Any]) {
        fileQueue.async { do { call.resolve(try action()) } catch let error as HemiDeviceError { call.reject(error.localizedDescription, error.code) } catch { call.reject("本机文件操作失败，请检查存储空间后重试。", "failed") } }
    }
    @objc func beginResource(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let size = call.getInt("size"), let sha256 = call.getString("sha256") else { call.reject("缺少文件信息。", "invalid"); return }
        resourceWork(call) { ["id": try self.resources.begin(name: name, size: size, sha256: sha256)] }
    }
    @objc func appendResource(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let offset = call.getInt("offset"), let base64 = call.getString("base64") else { call.reject("文件分片参数无效。", "invalid"); return }
        resourceWork(call) { try self.resources.append(id: id, offset: offset, base64: base64); return [:] }
    }
    @objc func finishResource(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("缺少文件身份。", "invalid"); return }
        resourceWork(call) { try self.resources.finish(id: id); return [:] }
    }
    @objc func removeResource(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("缺少文件身份。", "invalid"); return }
        resourceWork(call) { try self.resources.remove(id: id); return [:] }
    }
    @objc func presentResource(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let action = call.getString("action"), ["open","save","share"].contains(action) else { call.reject("文件操作无效。", "invalid"); return }
        DispatchQueue.main.async {
            guard self.resourcePresentation == nil, self.pickerCall == nil, self.scanner == nil, let presenter = self.bridge?.viewController, presenter.presentedViewController == nil else { call.reject("请先关闭当前系统面板。", "busy"); return }
            do {
                let url = try self.resources.retain(id: id); self.resourcePresentation = (id, url)
                let controller: UIViewController
                if action == "open" {
                    guard QLPreviewController.canPreview(url as NSURL) else { self.finishResourcePresentation(); call.reject("此格式请保存到文件或分享给其他 App。", "unsupported"); return }
                    let preview = QLPreviewController(); preview.dataSource = self; preview.delegate = self; controller = preview
                } else if action == "save" {
                    let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true); picker.delegate = self; self.resourceExport = picker; controller = picker
                } else {
                    let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                    share.completionWithItemsHandler = { [weak self] _, _, _, _ in self?.finishResourcePresentation() }
                    share.popoverPresentationController?.sourceView = presenter.view
                    share.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY - 1, width: 1, height: 1)
                    controller = share
                }
                presenter.present(controller, animated: true) { call.resolve(["presented": true]) }
            } catch let error as HemiDeviceError { call.reject(error.localizedDescription, error.code) }
            catch { call.reject("无法打开系统文件面板。", "failed") }
        }
    }
    public func numberOfPreviewItems(in controller: QLPreviewController) -> Int { resourcePresentation == nil ? 0 : 1 }
    public func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { resourcePresentation!.url as NSURL }
    public func previewControllerDidDismiss(_ controller: QLPreviewController) { finishResourcePresentation() }
    private func finishResourcePresentation() {
        if let value = resourcePresentation { resources.release(id: value.id) }; resourcePresentation = nil; resourceExport = nil
    }
    private func run(_ call: CAPPluginCall, _ action: @escaping () async throws -> [String: Any]) {
        Task {
            do { let result = try await action(); call.resolve(result)
                #if DEBUG
                print("HemiBot: native bridge resolved")
                #endif
            }
            catch let error as HemiDeviceError {
                #if DEBUG
                print("HemiBot: native bridge rejected: \(error.code)")
                #endif
                call.reject(error.localizedDescription, error.code)
            }
            catch { call.reject("无法连接 Bot，请检查网络、地址和证书后重试。", "network") }
        }
    }
    @objc func restore(_ call: CAPPluginCall) { run(call) { try await self.client.restore() } }
    @objc func prepare(_ call: CAPPluginCall) {
        guard let qr = call.getString("qr") else { call.reject("缺少配对码。", "invalid"); return }
        run(call) { try await self.client.prepare(qr, name: await MainActor.run { UIDevice.current.name }) }
    }
    @objc func pairRequest(_ call: CAPPluginCall) { run(call) { try await self.client.pairRequest() } }
    @objc func pairStatus(_ call: CAPPluginCall) { run(call) { try await self.client.pairStatus() } }
    @objc func cancelPairing(_ call: CAPPluginCall) { run(call) { try await self.client.pairStatus(cancel: true) } }
    @objc func forgetPairing(_ call: CAPPluginCall) { run(call) { try await self.client.forgetPairing(); return [:] } }
    @objc func forget(_ call: CAPPluginCall) { run(call) { try await self.client.forget(); return [:] } }
    @objc func request(_ call: CAPPluginCall) {
        guard let method = call.getString("method"), let params = call.getObject("params") else { call.reject("设备请求无效。", "invalid"); return }
        run(call) { try await self.client.request(method: method, params: params, requestId:call.getString("requestId")) }
    }
    @objc func cancelRequest(_ call: CAPPluginCall) {
        guard let requestId=call.getString("requestId") else {call.reject("缺少请求身份。","invalid");return}
        run(call) {await self.client.cancelRequest(requestId);return [:]}
    }
    @objc func openEvents(_ call: CAPPluginCall) {
        guard let streamId=call.getString("streamId"), let options=call.getObject("options") else {call.reject("订阅参数无效。","invalid");return}
        run(call) {
            try await self.client.openEvents(streamId:streamId,options:options,receive:{ [weak self] frame in
                DispatchQueue.main.async {self?.notifyListeners("botEvent",data:["streamId":streamId,"frame":frame])}
            },disconnected:{ [weak self] in
                DispatchQueue.main.async {self?.notifyListeners("botEvent",data:["streamId":streamId,"disconnected":true])}
            })
            return [:]
        }
    }
    @objc func closeEvents(_ call: CAPPluginCall) {
        guard let streamId=call.getString("streamId") else {call.reject("订阅参数无效。","invalid");return}
        run(call) {await self.client.closeEvents(streamId:streamId);return [:]}
    }
    @objc func scan(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.scanner == nil, self.pickerCall == nil, let presenter = self.bridge?.viewController else { call.reject("相机正在使用，请稍候。", "busy"); return }
            AVCaptureDevice.requestAccess(for: .video) { allowed in
                DispatchQueue.main.async {
                    guard allowed else { call.reject("请在系统设置中允许 Hemi 使用相机。", "permission"); return }
                    let scanner = HemiScannerController { [weak self] value, error in
                        self?.scanner?.dismiss(animated: true); self?.scanner = nil
                        if let value = value { call.resolve(["qr": value]) }
                        else { call.reject(error ?? "扫码已取消。", error == nil ? "cancelled" : "failed") }
                    }
                    self.scanner = scanner; scanner.modalPresentationStyle = .fullScreen
                    presenter.present(scanner, animated: true)
                }
            }
        }
    }
}

private final class HemiScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let capture = AVCaptureSession()
    private let queue = DispatchQueue(label: "ai.hemi.mobile.scanner")
    private var preview: AVCaptureVideoPreviewLayer?
    private var completed = false
    private let completion: (String?, String?) -> Void
    init(completion: @escaping (String?, String?) -> Void) { self.completion = completion; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        let preview = AVCaptureVideoPreviewLayer(session: capture); preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview); self.preview = preview
        let cancel = UIButton(type: .system); cancel.setTitle("取消", for: .normal); cancel.tintColor = .white
        cancel.titleLabel?.font = .systemFont(ofSize: 17); cancel.addTarget(self, action: #selector(cancelScan), for: .touchUpInside)
        cancel.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(cancel)
        let text = UILabel(); text.text = "扫描 PC 上的 Hemi 配对码"; text.textColor = .white; text.font = .systemFont(ofSize: 16); text.textAlignment = .center
        text.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(text)
        NSLayoutConstraint.activate([cancel.leadingAnchor.constraint(equalTo:view.safeAreaLayoutGuide.leadingAnchor,constant:16),cancel.topAnchor.constraint(equalTo:view.safeAreaLayoutGuide.topAnchor),cancel.widthAnchor.constraint(greaterThanOrEqualToConstant:60),cancel.heightAnchor.constraint(equalToConstant:44),text.leadingAnchor.constraint(equalTo:view.safeAreaLayoutGuide.leadingAnchor,constant:16),text.trailingAnchor.constraint(equalTo:view.safeAreaLayoutGuide.trailingAnchor,constant:-16),text.bottomAnchor.constraint(equalTo:view.safeAreaLayoutGuide.bottomAnchor,constant:-40)])
        queue.async {
            do {
                guard let device = AVCaptureDevice.default(for:.video) else { throw HemiDeviceError.message("此设备没有可用相机。", "unsupported") }
                let input = try AVCaptureDeviceInput(device:device), output = AVCaptureMetadataOutput()
                self.capture.beginConfiguration()
                guard self.capture.canAddInput(input), self.capture.canAddOutput(output) else { self.capture.commitConfiguration(); throw HemiDeviceError.message("无法打开相机。", "failed") }
                self.capture.addInput(input); self.capture.addOutput(output); output.setMetadataObjectsDelegate(self,queue:.main); output.metadataObjectTypes = [.qr]
                self.capture.commitConfiguration(); self.capture.startRunning()
            } catch { DispatchQueue.main.async { self.finish(nil,"无法打开相机，请关闭其他使用相机的应用后重试。") } }
        }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
    override func viewDidDisappear(_ animated: Bool) { super.viewDidDisappear(animated); queue.async { self.capture.stopRunning() } }
    @objc private func cancelScan() { finish(nil,nil) }
    private func finish(_ value: String?, _ error: String?) { guard !completed else { return }; completed = true; queue.async { self.capture.stopRunning() }; completion(value,error) }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        guard value.utf8.count <= 2048 else { finish(nil,"配对码内容过长。请扫描 Hemi 生成的配对码。"); return }
        finish(value,nil)
    }
}
