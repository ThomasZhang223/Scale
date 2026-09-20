import Foundation
import ModelIO
import UIKit
import simd

// USDZ (PhotogrammetrySession's output) → glTF 2.0 binary, on the phone.
//
// Why this exists: the headset runtime (apps/xr) loads GLB through three.js's
// GLTFLoader, and the Object v1 contract carries a `glbUrl`. There is no
// glTF writer in any Apple framework, and no server in this stack can run a
// converter (Workers cannot, and services/gen is Baseten-bound). Model I/O
// reads USDZ natively, so we walk its meshes and write the small subset of
// glTF that a textured photogrammetry scan needs: positions, normals, UVs,
// triangle indices, one base-colour JPEG per material.
//
// Scale: Object Capture writes metres (metersPerUnit = 1), Model I/O keeps
// them, glTF is metres. Nothing here rescales anything — the one binding
// step of standing rule 2 does not exist for this path because the sensor
// already produced true size.
enum GLBExporter {
  enum ExportError: Error, LocalizedError {
    case noMeshes
    case unsupportedGeometry(String)
    var errorDescription: String? {
      switch self {
      case .noMeshes: return "The reconstructed USDZ contains no meshes"
      case .unsupportedGeometry(let s): return "Unsupported geometry in USDZ: \(s)"
      }
    }
  }

  private struct Primitive {
    var positionsOffset = 0, positionsCount = 0
    var normalsOffset = 0
    var uvsOffset = 0
    var indicesOffset = 0, indicesCount = 0
    var minP = SIMD3<Float>(repeating: .greatestFiniteMagnitude)
    var maxP = SIMD3<Float>(repeating: -.greatestFiniteMagnitude)
    var material = 0
  }

  private struct MaterialOut {
    var imageIndex: Int?
    var baseColor: SIMD4<Float> = [1, 1, 1, 1]
  }

  /// Writes the GLB and returns the axis-aligned size of the whole model in metres.
  static func export(usdz: URL, to output: URL) throws -> SIMD3<Float> {
    let asset = MDLAsset(url: usdz)
    asset.loadTextures()
    guard let meshes = asset.childObjects(of: MDLMesh.self) as? [MDLMesh], !meshes.isEmpty else {
      throw ExportError.noMeshes
    }

    var bin = Data()
    var primitives: [Primitive] = []
    var materials: [MaterialOut] = []
    var images: [(offset: Int, length: Int, mime: String)] = []
    var textureCache: [ObjectIdentifier: Int] = [:]
    var globalMin = SIMD3<Float>(repeating: .greatestFiniteMagnitude)
    var globalMax = SIMD3<Float>(repeating: -.greatestFiniteMagnitude)

    func pad4(_ d: inout Data) { while d.count % 4 != 0 { d.append(0) } }

    for mesh in meshes {
      let world = worldTransform(of: mesh)
      let normalMatrix = simd_transpose(simd_inverse(simd_float3x3(
        SIMD3(world.columns.0.x, world.columns.0.y, world.columns.0.z),
        SIMD3(world.columns.1.x, world.columns.1.y, world.columns.1.z),
        SIMD3(world.columns.2.x, world.columns.2.y, world.columns.2.z))))

      if mesh.vertexAttributeData(forAttributeNamed: MDLVertexAttributeNormal) == nil {
        mesh.addNormals(withAttributeNamed: MDLVertexAttributeNormal, creaseThreshold: 0.5)
      }
      let count = mesh.vertexCount
      guard let pos = mesh.vertexAttributeData(forAttributeNamed: MDLVertexAttributePosition, as: .float3) else {
        throw ExportError.unsupportedGeometry("mesh without positions")
      }
      let nrm = mesh.vertexAttributeData(forAttributeNamed: MDLVertexAttributeNormal, as: .float3)
      let uv = mesh.vertexAttributeData(forAttributeNamed: MDLVertexAttributeTextureCoordinate, as: .float2)

      var positions = [SIMD3<Float>](); positions.reserveCapacity(count)
      var normals = [SIMD3<Float>](); normals.reserveCapacity(count)
      var uvs = [SIMD2<Float>](); uvs.reserveCapacity(count)
      var minP = SIMD3<Float>(repeating: .greatestFiniteMagnitude)
      var maxP = SIMD3<Float>(repeating: -.greatestFiniteMagnitude)

      for i in 0..<count {
        let p = pos.dataStart.advanced(by: i * pos.stride).assumingMemoryBound(to: Float.self)
        let local = SIMD4<Float>(p[0], p[1], p[2], 1)
        let w = world * local
        let v = SIMD3<Float>(w.x, w.y, w.z)
        positions.append(v)
        minP = simd_min(minP, v); maxP = simd_max(maxP, v)

        if let nrm {
          let n = nrm.dataStart.advanced(by: i * nrm.stride).assumingMemoryBound(to: Float.self)
          normals.append(simd_normalize(normalMatrix * SIMD3<Float>(n[0], n[1], n[2])))
        } else {
          normals.append(SIMD3<Float>(0, 1, 0))
        }
        if let uv {
          let t = uv.dataStart.advanced(by: i * uv.stride).assumingMemoryBound(to: Float.self)
          // USD's UV origin is bottom-left, glTF's is top-left.
          uvs.append(SIMD2<Float>(t[0], 1 - t[1]))
        } else {
          uvs.append(.zero)
        }
      }
      globalMin = simd_min(globalMin, minP); globalMax = simd_max(globalMax, maxP)

      pad4(&bin)
      let positionsOffset = bin.count
      positions.withUnsafeBufferPointer { bin.append(Data(buffer: $0)) }
      pad4(&bin)
      let normalsOffset = bin.count
      normals.withUnsafeBufferPointer { bin.append(Data(buffer: $0)) }
      pad4(&bin)
      let uvsOffset = bin.count
      uvs.withUnsafeBufferPointer { bin.append(Data(buffer: $0)) }

      guard let submeshes = mesh.submeshes as? [MDLSubmesh] else { continue }
      for sub in submeshes {
        guard sub.geometryType == .triangles else {
          throw ExportError.unsupportedGeometry("\(sub.geometryType) submesh; only triangles are handled")
        }
        // Always UInt32 on the way out — simpler than carrying two accessor types.
        let indexCount = sub.indexCount
        var indices = [UInt32](repeating: 0, count: indexCount)
        let map = sub.indexBuffer.map()
        switch sub.indexType {
        case .uInt32, .uint32:
          let src = map.bytes.assumingMemoryBound(to: UInt32.self)
          for i in 0..<indexCount { indices[i] = src[i] }
        case .uInt16, .uint16:
          let src = map.bytes.assumingMemoryBound(to: UInt16.self)
          for i in 0..<indexCount { indices[i] = UInt32(src[i]) }
        case .uInt8, .uint8:
          let src = map.bytes.assumingMemoryBound(to: UInt8.self)
          for i in 0..<indexCount { indices[i] = UInt32(src[i]) }
        default:
          throw ExportError.unsupportedGeometry("index type \(sub.indexType.rawValue)")
        }
        pad4(&bin)
        let indicesOffset = bin.count
        indices.withUnsafeBufferPointer { bin.append(Data(buffer: $0)) }

        // Material: the base colour texture if there is one, else the flat colour.
        var mat = MaterialOut()
        if let material = sub.material, let prop = material.property(with: .baseColor) {
          switch prop.type {
          case .texture:
            if let tex = prop.textureSamplerValue?.texture {
              let key = ObjectIdentifier(tex)
              if let cached = textureCache[key] {
                mat.imageIndex = cached
              } else if let cg = tex.imageFromTexture()?.takeRetainedValue(),
                        let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.88) {
                pad4(&bin)
                let off = bin.count
                bin.append(jpeg)
                images.append((off, jpeg.count, "image/jpeg"))
                textureCache[key] = images.count - 1
                mat.imageIndex = images.count - 1
              }
            }
          case .float3:
            let c = prop.float3Value; mat.baseColor = [c.x, c.y, c.z, 1]
          case .float4:
            mat.baseColor = prop.float4Value
          case .color:
            if let comps = prop.color?.components, comps.count >= 3 {
              mat.baseColor = [Float(comps[0]), Float(comps[1]), Float(comps[2]), 1]
            }
          default: break
          }
        }
        materials.append(mat)

        primitives.append(Primitive(
          positionsOffset: positionsOffset, positionsCount: count,
          normalsOffset: normalsOffset, uvsOffset: uvsOffset,
          indicesOffset: indicesOffset, indicesCount: indexCount,
          minP: minP, maxP: maxP, material: materials.count - 1))
      }
    }
    pad4(&bin)
    guard !primitives.isEmpty else { throw ExportError.noMeshes }

    // --- glTF JSON ---------------------------------------------------------
    var bufferViews: [[String: Any]] = []
    var accessors: [[String: Any]] = []
    var gltfPrimitives: [[String: Any]] = []

    for p in primitives {
      let pv = bufferViews.count
      bufferViews.append(["buffer": 0, "byteOffset": p.positionsOffset, "byteLength": p.positionsCount * 12, "target": 34962])
      let nv = bufferViews.count
      bufferViews.append(["buffer": 0, "byteOffset": p.normalsOffset, "byteLength": p.positionsCount * 12, "target": 34962])
      let tv = bufferViews.count
      bufferViews.append(["buffer": 0, "byteOffset": p.uvsOffset, "byteLength": p.positionsCount * 8, "target": 34962])
      let iv = bufferViews.count
      bufferViews.append(["buffer": 0, "byteOffset": p.indicesOffset, "byteLength": p.indicesCount * 4, "target": 34963])

      let pa = accessors.count
      accessors.append(["bufferView": pv, "componentType": 5126, "count": p.positionsCount, "type": "VEC3",
                        "min": [p.minP.x, p.minP.y, p.minP.z], "max": [p.maxP.x, p.maxP.y, p.maxP.z]])
      let na = accessors.count
      accessors.append(["bufferView": nv, "componentType": 5126, "count": p.positionsCount, "type": "VEC3"])
      let ta = accessors.count
      accessors.append(["bufferView": tv, "componentType": 5126, "count": p.positionsCount, "type": "VEC2"])
      let ia = accessors.count
      accessors.append(["bufferView": iv, "componentType": 5125, "count": p.indicesCount, "type": "SCALAR"])

      gltfPrimitives.append([
        "attributes": ["POSITION": pa, "NORMAL": na, "TEXCOORD_0": ta],
        "indices": ia,
        "material": p.material,
        "mode": 4,
      ])
    }

    var gltfImages: [[String: Any]] = []
    var gltfTextures: [[String: Any]] = []
    for img in images {
      bufferViews.append(["buffer": 0, "byteOffset": img.offset, "byteLength": img.length])
      gltfImages.append(["bufferView": bufferViews.count - 1, "mimeType": img.mime])
      gltfTextures.append(["source": gltfImages.count - 1, "sampler": 0])
    }

    let gltfMaterials: [[String: Any]] = materials.map { m in
      var pbr: [String: Any] = ["metallicFactor": 0.0, "roughnessFactor": 1.0]
      if let idx = m.imageIndex {
        pbr["baseColorTexture"] = ["index": idx]
      } else {
        pbr["baseColorFactor"] = [m.baseColor.x, m.baseColor.y, m.baseColor.z, m.baseColor.w]
      }
      return ["pbrMetallicRoughness": pbr, "doubleSided": true]
    }

    var gltf: [String: Any] = [
      "asset": ["version": "2.0", "generator": "Full Scale ObjectCapture GLBExporter"],
      "scene": 0,
      "scenes": [["nodes": [0]]],
      "nodes": [["mesh": 0, "name": "object"]],
      "meshes": [["primitives": gltfPrimitives, "name": "object"]],
      "materials": gltfMaterials,
      "accessors": accessors,
      "bufferViews": bufferViews,
      "buffers": [["byteLength": bin.count]],
    ]
    if !images.isEmpty {
      gltf["images"] = gltfImages
      gltf["textures"] = gltfTextures
      gltf["samplers"] = [["magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497]]
    }

    var json = try JSONSerialization.data(withJSONObject: gltf, options: [])
    while json.count % 4 != 0 { json.append(0x20) } // JSON chunk pads with spaces

    // --- GLB container ----------------------------------------------------
    var glb = Data()
    func u32(_ v: UInt32) { var le = v.littleEndian; glb.append(Data(bytes: &le, count: 4)) }
    u32(0x46546C67) // 'glTF'
    u32(2)
    u32(UInt32(12 + 8 + json.count + 8 + bin.count))
    u32(UInt32(json.count)); u32(0x4E4F534A) // 'JSON'
    glb.append(json)
    u32(UInt32(bin.count)); u32(0x004E4942) // 'BIN\0'
    glb.append(bin)
    try glb.write(to: output, options: .atomic)

    return globalMax - globalMin
  }

  private static func worldTransform(of object: MDLObject) -> simd_float4x4 {
    var m = matrix_identity_float4x4
    var node: MDLObject? = object
    while let n = node {
      if let t = n.transform { m = t.matrix * m }
      node = n.parent
    }
    return m
  }
}
