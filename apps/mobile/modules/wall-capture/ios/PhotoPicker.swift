import PhotosUI
import UIKit
import UniformTypeIdentifiers

// Apple's photo picker, presented by this module so the app needs neither a
// picker dependency nor a photo-library permission (PHPicker runs out of
// process and hands back only what the user chose). Resolves to a local
// file path, or nil when the user cancels.
@MainActor
final class PhotoPicker: NSObject, PHPickerViewControllerDelegate {
  private static var current: PhotoPicker?
  private let continuation: CheckedContinuation<String?, Error>

  private init(_ c: CheckedContinuation<String?, Error>) { continuation = c }

  static func pick() async throws -> String? {
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<String?, Error>) in
      guard let top = topViewController() else {
        c.resume(throwing: NSError(domain: "WallCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "No view controller to present the photo picker from"]))
        return
      }
      var config = PHPickerConfiguration(photoLibrary: .shared())
      config.filter = .images
      config.selectionLimit = 1
      let picker = PHPickerViewController(configuration: config)
      let delegate = PhotoPicker(c)
      picker.delegate = delegate
      current = delegate
      top.present(picker, animated: true)
    }
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    guard let provider = results.first?.itemProvider else {
      finish(.success(nil))
      return
    }
    provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, error in
      // The URL lives only for this callback: copy before returning.
      guard let url else {
        Task { @MainActor in self.finish(.failure(error ?? NSError(domain: "WallCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "The photo could not be read"]))) }
        return
      }
      let dest = FileManager.default.temporaryDirectory.appendingPathComponent("pick-\(UUID().uuidString).\(url.pathExtension.isEmpty ? "jpg" : url.pathExtension)")
      do {
        try FileManager.default.copyItem(at: url, to: dest)
        Task { @MainActor in self.finish(.success(dest.path)) }
      } catch {
        Task { @MainActor in self.finish(.failure(error)) }
      }
    }
  }

  private func finish(_ result: Result<String?, Error>) {
    switch result {
    case .success(let path): continuation.resume(returning: path)
    case .failure(let error): continuation.resume(throwing: error)
    }
    Self.current = nil
  }

  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first?.windows.first
    var vc = window?.rootViewController
    while let presented = vc?.presentedViewController { vc = presented }
    return vc
  }
}
